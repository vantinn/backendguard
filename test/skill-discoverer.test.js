import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSkillGraph,
  diagnoseSkills,
  expandSkillGraphSuggestions,
  parseSkillFrontmatter,
  parseSkillMarkdownAst,
  parseSkillMetadata,
  projectSkillHints,
  scanSkills,
  skillSchemaFromMarkdownAst,
  skillSearchRoots,
  suggestSkills
} from "../plugins/ctx/lib/skill-discoverer.js";

describe("skill discoverer", () => {
  it("parses SKILL.md YAML frontmatter", () => {
    const skill = parseSkillFrontmatter([
      "---",
      "name: payment-integration",
      "description: Use when building payment provider webhooks and checkout flows.",
      "---",
      "",
      "# Payment"
    ].join("\n"), {
      fallbackName: "fallback",
      skillPath: "/repo/.claude/skills/payment-integration/SKILL.md"
    });

    expect(skill).toMatchObject({
      name: "payment-integration",
      description: "Use when building payment provider webhooks and checkout flows.",
      path: "/repo/.claude/skills/payment-integration/SKILL.md"
    });
  });

  it("falls back to directory name and first body paragraph", () => {
    const skill = parseSkillFrontmatter("# Debugger\n\nUse for root cause analysis.", {
      skillPath: "/repo/.codex/skills/debugger/SKILL.md"
    });

    expect(skill.name).toBe("debugger");
    expect(skill.description).toBe("Debugger");
  });

  it("truncates very long descriptions before scoring", () => {
    const skill = parseSkillFrontmatter([
      "---",
      "name: huge-skill",
      `description: ${"long ".repeat(300)}`,
      "---"
    ].join("\n"), {
      skillPath: "/repo/.codex/skills/huge-skill/SKILL.md"
    });

    expect(skill.description.length).toBeLessThanOrEqual(500);
  });

  it("parses skill.yaml trigger metadata", () => {
    expect(parseSkillMetadata([
      "id: eas",
      "intent:",
      "  - deployment",
      "positive_triggers:",
      "  prompts:",
      "    - deployed",
      "    - eas",
      "  files:",
      "    - eas.json",
      "  dependencies:",
      "    - expo",
      "negative_triggers:",
      "  dependencies:",
      "    - next",
      "depends_on:",
      "  - github-actions-ci-cd",
      "provides:",
      "  - mobile-deployment"
    ].join("\n"))).toMatchObject({
      id: "eas",
      intent: ["deployment"],
      positivePrompts: ["deployed", "eas"],
      files: ["eas.json"],
      dependencies: ["expo"],
      negativeDependencies: ["next"],
      dependsOn: ["github-actions-ci-cd"],
      provides: ["mobile-deployment"]
    });
  });

  it("normalizes markdown skill sections into router schema", () => {
    const ast = parseSkillMarkdownAst([
      "# OAuth Google",
      "",
      "## Triggers",
      "- oauth",
      "- google login",
      "",
      "## Evidence",
      "- passport-google-oauth20",
      "- auth.service.ts",
      "",
      "## Related Skills",
      "- jwt-auth",
      "",
      "## Provides",
      "- social-login"
    ].join("\n"));
    const schema = skillSchemaFromMarkdownAst(ast);

    expect(schema).toMatchObject({
      positivePrompts: ["oauth", "google login"],
      dependencies: ["passport-google-oauth20"],
      files: ["auth.service.ts"],
      relatedSkills: ["jwt-auth"],
      provides: ["social-login"]
    });
  });

  it("builds and expands skill graph relationships from metadata", () => {
    const oauth = {
      name: "oauth-google",
      description: "Google OAuth login.",
      metadata: {
        id: "oauth-google",
        relatedSkills: ["jwt-auth"],
        dependsOn: ["passport"]
      }
    };
    const jwt = {
      name: "jwt-auth",
      description: "JWT auth.",
      metadata: { id: "jwt-auth" }
    };
    const passport = {
      name: "passport",
      description: "Passport providers.",
      metadata: { id: "passport" }
    };

    expect(buildSkillGraph([oauth, jwt, passport]).edges).toEqual(expect.arrayContaining([
      { from: "oauth-google", to: "jwt-auth", type: "related_to" },
      { from: "oauth-google", to: "passport", type: "depends_on" }
    ]));
    expect(expandSkillGraphSuggestions({ seeds: [oauth], catalog: [oauth, jwt, passport] }).map((skill) => skill.name)).toEqual([
      "jwt-auth",
      "passport"
    ]);
  });


  it("scans global/project style skill directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skills-"));
    const skillDir = path.join(tmp, ".claude", "skills", "planning");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: planning",
      "description: Use for task breakdown and architecture decisions.",
      "---"
    ].join("\n"));

    const skills = scanSkills({
      cwd: tmp,
      roots: [path.join(tmp, ".claude", "skills")]
    });

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "planning" });
  });

  it("includes .agents skill roots", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-agents-home-"));
    const roots = skillSearchRoots({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-agents-cwd-")), home });

    expect(roots).toEqual(expect.arrayContaining([
      path.join(home, ".agents", "skills")
    ]));
  });

  it("scans Antigravity skill directories", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-agy-skills-"));
    const skillDir = path.join(tmp, ".gemini", "antigravity", "skills", "payment-integration");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
      "---",
      "name: payment-integration",
      "description: Use for payment checkout and billing webhook tasks.",
      "---"
    ].join("\n"));

    const skills = scanSkills({
      cwd: tmp,
      roots: [path.join(tmp, ".gemini", "antigravity", "skills")]
    });

    expect(skills.map((skill) => skill.name)).toContain("payment-integration");
  });

  it("caches scans even when the max skill limit is reached", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-cache-"));
    const root = path.join(tmp, ".codex", "skills");
    writeSkill(path.join(root, "one"), "one");
    writeSkill(path.join(root, "two"), "two");

    const first = scanSkills({ cwd: tmp, roots: [root], maxSkills: 1 });
    fs.rmSync(path.join(root, "one"), { recursive: true, force: true });
    fs.rmSync(path.join(root, "two"), { recursive: true, force: true });
    const second = scanSkills({ cwd: tmp, roots: [root], maxSkills: 1 });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].name).toBe(first[0].name);
  });

  it("suggests top skills without being affected by catalog size/order", async () => {
    const skills = Array.from({ length: 50 }, (_, index) => ({
      name: `zzz-${index}`,
      description: "Use for unrelated infrastructure maintenance.",
      path: `/skills/zzz-${index}/SKILL.md`
    }));
    skills.push({
      name: "payment-integration",
      description: "Use when creating payment provider integrations, checkout sessions, billing webhooks, and invoices.",
      path: "/skills/payment-integration/SKILL.md"
    });

    const suggested = await suggestSkills({
      prompt: "create a new payment integration with checkout webhook",
      skills,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-data-")),
      limit: 3,
      indexedSearcher: indexedSearcherFor({
        "payment-integration": 0.91,
        "zzz-1": 0.2
      })
    });

    expect(suggested[0].name).toBe("payment-integration");
  });

  it("preserves explicitly requested $ skills before semantic suggestions", async () => {
    const suggested = await suggestSkills({
      prompt: "$threejs $threejs-animation $threejs-interaction $design-taste-frontend design all card again",
      skills: [
        {
          name: "threejs",
          description: "Build immersive 3D web experiences with Three.js.",
          path: "/home/user/.agents/skills/threejs/SKILL.md"
        },
        {
          name: "threejs-animation",
          description: "Three.js animation with keyframes, mixers, and procedural motion.",
          path: "/home/user/.agents/skills/threejs-animation/SKILL.md"
        },
        {
          name: "threejs-interaction",
          description: "Three.js interaction with raycasting, controls, and pointer input.",
          path: "/home/user/.agents/skills/threejs-interaction/SKILL.md"
        },
        {
          name: "design-taste-frontend",
          description: "Build high-agency frontend interfaces with strict design taste.",
          path: "/home/user/.agents/skills/design-taste-frontend/SKILL.md"
        },
        {
          name: "unrelated",
          description: "Use for unrelated maintenance tasks.",
          path: "/skills/unrelated/SKILL.md"
        }
      ],
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-explicit-data-")),
      indexedSearcher: indexedSearcherFor({
        unrelated: 0.95
      }),
      limit: 5
    });

    expect(suggested.map((skill) => skill.name)).toEqual([
      "threejs",
      "threejs-animation",
      "threejs-interaction",
      "design-taste-frontend",
      "unrelated"
    ]);
    expect(suggested.slice(0, 4).map((skill) => skill.reasons)).toEqual([
      ["explicit-skill"],
      ["explicit-skill"],
      ["explicit-skill"],
      ["explicit-skill"]
    ]);
  });

  it("falls back to shared global skill index for workspaces without a local skill index", async () => {
    const seenKinds = [];
    const suggested = await suggestSkills({
      cwd: "/repo/new-workspace",
      prompt: "fix jest e2e test supertest missing typescript declarations",
      skills: [
        {
          name: "testing-patterns",
          description: "Use for Jest, E2E tests, TypeScript test fixes, and test dependency setup.",
          path: "/skills/testing-patterns/SKILL.md"
        }
      ],
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-shared-index-")),
      indexedSearcher: async ({ kind }) => {
        seenKinds.push(kind);
        return {
          status: "enabled",
          items: kind === "skill:global"
            ? [{ id: "testing patterns", text: "testing-patterns", embeddingScore: 0.91 }]
            : []
        };
      },
      limit: 3
    });

    expect(seenKinds).toEqual([
      `skill:${path.resolve("/repo/new-workspace")}`,
      "skill:global"
    ]);
    expect(suggested.map((skill) => skill.name)).toEqual(["testing-patterns"]);
  });

  it("does not suggest unrelated skills from generic setup and package tokens", async () => {
    const skills = Array.from({ length: 301 }, (_, index) => ({
      name: `unrelated-${index}`,
      description: "Use for unrelated maintenance tasks.",
      path: `/skills/unrelated-${index}/SKILL.md`
    }));
    skills.push(
      {
        name: "azure-postgres-ts",
        description: "Connect to Azure Database for PostgreSQL Flexible Server from Node.js using the pg package.",
        path: "/skills/azure-postgres-ts/SKILL.md"
      },
      {
        name: "devcontainer-setup",
        description: "Use when setting up isolated Node.js development environments.",
        path: "/skills/devcontainer-setup/SKILL.md"
      }
    );

    const suggested = await suggestSkills({
      prompt: "ctx setup sync package rebuild graph embeddings",
      skills,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-empty-data-")),
      indexedSearcher: indexedSearcherFor({
        "azure-postgres-ts": 0.2,
        "devcontainer-setup": 0.18
      }),
      limit: 3
    });

    expect(suggested).toEqual([]);
  });

  it("deduplicates repeated skill names across roots", async () => {
    const suggested = await suggestSkills({
      prompt: "create payment checkout webhook integration",
      skills: [
        {
          name: "payment-integration",
          description: "Use when creating payment checkout sessions and billing webhooks.",
          path: "/skills/one/payment-integration/SKILL.md"
        },
        {
          name: "payment-integration",
          description: "Use when creating payment checkout sessions and billing webhooks.",
          path: "/skills/two/payment-integration/SKILL.md"
        }
      ],
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-dedupe-")),
      indexedSearcher: indexedSearcherFor({
        "payment-integration": 0.9
      })
    });

    expect(suggested.map((skill) => skill.name)).toEqual(["payment-integration"]);
  });

  it("prefers Expo EAS workflow skills from semantic search over fused project context", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-expo-"));
    fs.mkdirSync(path.join(cwd, "webapp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: ["webapp"]
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "package.json"), JSON.stringify({
      dependencies: { expo: "^53.0.0", "react-native": "^0.79.0" }
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "eas.json"), "{}");

    const suggested = await suggestSkills({
      cwd,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-expo-cache-")),
      prompt: "handle https://github.com/example/app/issues/116 EAS config iOS Android preview production",
      skills: [
        {
          name: "audit-skills",
          description: "Audit mobile Android and iOS applications.",
          path: "/skills/audit/SKILL.md"
        },
        {
          name: "expo-api-routes",
          description: "Create Expo Router API routes with EAS Hosting.",
          path: "/skills/expo-api/SKILL.md"
        },
        {
          name: "llm-app-patterns",
          description: "Production-ready LLM patterns inspired by https://github.com/example/llm.",
          path: "/skills/llm/SKILL.md"
        },
        {
          name: "expo-cicd-workflows",
          description: "Write EAS workflow YAML files for Expo projects and build pipelines.",
          path: "/skills/expo/SKILL.md"
        }
      ],
      indexedSearcher: indexedSearcherFor({
        "expo-cicd-workflows": 0.92,
        "expo-api-routes": 0.76,
        "audit-skills": 0.2,
        "llm-app-patterns": 0.15
      })
    });

    expect(projectSkillHints({ cwd })).toEqual(expect.arrayContaining(["expo", "react", "native", "eas", "json"]));
    expect(suggested[0].name).toBe("expo-cicd-workflows");
    expect(suggested.map((skill) => skill.name)).not.toContain("audit-skills");
  });

  it("uses skill.yaml project evidence and negative triggers for deployment routing", async () => {
    const expoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-router-expo-"));
    fs.mkdirSync(path.join(expoRoot, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(expoRoot, "package.json"), JSON.stringify({
      dependencies: { expo: "^56.0.0", "react-native": "^0.85.0" }
    }));
    fs.writeFileSync(path.join(expoRoot, "eas.json"), "{}");
    fs.writeFileSync(path.join(expoRoot, "app.json"), "{}");
    fs.writeFileSync(path.join(expoRoot, ".github", "workflows", "build.yml"), "name: build\n");

    const skillsRoot = path.join(expoRoot, ".codex", "skills");
    writeSkillWithMetadata(path.join(skillsRoot, "eas"), "eas", [
      "id: eas",
      "positive_triggers:",
      "  prompts:",
      "    - deployed",
      "    - deploy",
      "  files:",
      "    - eas.json",
      "    - app.json",
      "    - .github/workflows/*",
      "  dependencies:",
      "    - expo",
      "negative_triggers:",
      "  dependencies:",
      "    - next"
    ].join("\n"));
    writeSkillWithMetadata(path.join(skillsRoot, "vercel-deployment"), "vercel-deployment", [
      "id: vercel-deployment",
      "positive_triggers:",
      "  prompts:",
      "    - deployed",
      "  files:",
      "    - vercel.json",
      "  dependencies:",
      "    - next",
      "negative_triggers:",
      "  dependencies:",
      "    - expo"
    ].join("\n"));

    const expoSkills = scanSkills({ cwd: expoRoot, roots: [skillsRoot] });
    const expoSuggested = await suggestSkills({
      cwd: expoRoot,
      prompt: "fix deployed",
      skills: expoSkills,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-router-expo-data-")),
      indexedSearcher: indexedSearcherFor({
        eas: 0.7,
        "vercel-deployment": 0.7
      }),
      limit: 2
    });

    expect(expoSuggested[0].name).toBe("eas");
    expect(expoSuggested[0].confidence).toBeGreaterThan(0.7);
    expect(expoSuggested[0].evidence).toEqual(expect.arrayContaining([
      "dependency:expo",
      "file:eas.json"
    ]));
    expect(expoSuggested.map((skill) => skill.name)).not.toContain("vercel-deployment");

    const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-router-next-"));
    fs.writeFileSync(path.join(nextRoot, "package.json"), JSON.stringify({
      dependencies: { next: "^15.0.0", react: "^19.0.0" }
    }));
    fs.writeFileSync(path.join(nextRoot, "vercel.json"), "{}");
    const nextSuggested = await suggestSkills({
      cwd: nextRoot,
      prompt: "fix deployed",
      skills: expoSkills,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-router-next-data-")),
      indexedSearcher: indexedSearcherFor({
        eas: 0.7,
        "vercel-deployment": 0.7
      }),
      limit: 2
    });

    expect(nextSuggested[0].name).toBe("vercel-deployment");
    expect(nextSuggested.map((skill) => skill.name)).not.toContain("eas");
  });

  it("explains skill routing decisions for doctor output", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-doctor-"));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      dependencies: { expo: "^56.0.0" }
    }));
    fs.writeFileSync(path.join(cwd, "eas.json"), "{}");
    const skills = [{
      name: "eas",
      description: "Fix Expo EAS deployments.",
      path: "/skills/eas/SKILL.md"
    }];

    const result = await diagnoseSkills({
      cwd,
      prompt: "fix deployed",
      skills,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-doctor-data-")),
      indexedSearcher: indexedSearcherFor({ eas: 0.8 }),
      limit: 1
    });

    expect(result.projectEvidence.dependencies).toContain("expo");
    expect(result.skills[0]).toMatchObject({
      name: "eas",
      confidenceBand: "high"
    });
    expect(result.skills[0].evidence).toEqual(expect.arrayContaining([
      "dependency:expo",
      "file:eas.json"
    ]));
  });

  it("suggests frontend and auth skills for Vietnamese role-based UI prompts", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-next-role-"));
    fs.mkdirSync(path.join(cwd, "webapp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: ["webapp"]
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "package.json"), JSON.stringify({
      dependencies: { next: "^15.0.0", react: "^19.0.0", tailwindcss: "^4.0.0" },
      devDependencies: { typescript: "^5.0.0" }
    }));

    const suggested = await suggestSkills({
      cwd,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-next-role-cache-")),
      prompt: "triển khai giao diện theo role, webapp/src/app/(private)/dashboard chỉ dành cho role ADMIN, CREATOR mới có button create page",
      skills: [
        ...Array.from({ length: 301 }, (_, index) => ({
          name: `unrelated-${index}`,
          description: "Use for unrelated maintenance tasks.",
          path: `/skills/unrelated-${index}/SKILL.md`
        })),
        {
          name: "frontend-developer",
          description: "Build React components, implement responsive layouts, and handle client-side state management. Masters React 19, Next.js 15, and modern frontend architecture.",
          path: "/skills/frontend-developer/SKILL.md"
        },
        {
          name: "frontend-ui-dark-ts",
          description: "A modern dark-themed React UI system using Tailwind CSS and Framer Motion for dashboards, admin panels, and glassmorphism interfaces.",
          path: "/skills/frontend-ui-dark-ts/SKILL.md"
        },
        {
          name: "nextjs-app-router-patterns",
          description: "Comprehensive patterns for Next.js 14+ App Router architecture, Server Components, routing, and modern full-stack React development.",
          path: "/skills/nextjs-app-router-patterns/SKILL.md"
        },
        {
          name: "nextjs-best-practices",
          description: "Next.js App Router principles. Server Components, data fetching, routing patterns.",
          path: "/skills/nextjs-best-practices/SKILL.md"
        },
        {
          name: "react-nextjs-development",
          description: "React and Next.js 14+ application development with App Router, Server Components, TypeScript, Tailwind CSS, and modern frontend patterns.",
          path: "/skills/react-nextjs-development/SKILL.md"
        },
        {
          name: "auth-implementation-patterns",
          description: "Build secure authentication and authorization systems with role-based access control and permission checks.",
          path: "/skills/auth/SKILL.md"
        },
        {
          name: "azure-postgres-ts",
          description: "Connect to Azure Database for PostgreSQL Flexible Server from Node.js using the pg package.",
          path: "/skills/azure-postgres-ts/SKILL.md"
        }
      ],
      indexedSearcher: indexedSearcherFor({
        "nextjs-app-router-patterns": 0.93,
        "nextjs-best-practices": 0.89,
        "react-nextjs-development": 0.84,
        "frontend-developer": 0.7,
        "azure-postgres-ts": 0.1
      }),
      limit: 3
    });

    expect(suggested.map((skill) => skill.name)).toEqual([
      "nextjs-app-router-patterns",
      "nextjs-best-practices",
      "react-nextjs-development"
    ]);
  });

  it("uses global skills with project evidence for forum and chat feature prompts", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-global-forum-"));
    fs.mkdirSync(path.join(cwd, "webapp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: ["webapp"]
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "package.json"), JSON.stringify({
      dependencies: { next: "^15.0.0", react: "^19.0.0" }
    }));

    const suggested = await suggestSkills({
      cwd,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-global-forum-cache-")),
      prompt: "create forum page, where to show new topic, trending, and chatting everyone",
      skills: [
        {
          name: "nextjs-app-router-patterns",
          description: "Build Next.js App Router pages, layouts, route groups, and React UI features.",
          path: "/home/user/.agents/skills/nextjs-app-router-patterns/SKILL.md",
          scope: "global"
        },
        {
          name: "realtime-chat",
          description: "Implement forum discussions, topics, realtime chat, messages, and websocket UX.",
          path: "/home/user/.config/skillshare/skills/realtime-chat/SKILL.md",
          scope: "global"
        },
        {
          name: "metasploit-framework",
          description: "Use for penetration testing and exploit workflows.",
          path: "/home/user/.agents/skills/metasploit-framework/SKILL.md",
          scope: "global"
        }
      ],
      indexedSearcher: indexedSearcherFor({
        "nextjs-app-router-patterns": 0.93,
        "realtime-chat": 0.9,
        "metasploit-framework": 0.2
      }),
      limit: 3
    });

    expect(suggested.map((skill) => skill.name)).toEqual([
      "realtime-chat",
      "nextjs-app-router-patterns"
    ]);
    expect(suggested[0].evidence).toEqual(expect.arrayContaining([
      "source:community",
      "dependency:next",
      "file:package.json"
    ]));
    expect(suggested[1].sourceBoostScore).toBe(0);
  });

  it("suggests Expo runtime skills for QR/connect run prompts in Expo projects", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-expo-qr-"));
    fs.mkdirSync(path.join(cwd, "webapp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: ["webapp"],
      description: "React Native frontend"
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "package.json"), JSON.stringify({
      dependencies: {
        expo: "^56.0.0",
        "expo-router": "^6.0.0",
        nativewind: "^5.0.0",
        react: "^19.0.0",
        "react-native": "^0.85.0"
      },
      devDependencies: {
        tailwindcss: "^4.0.0"
      }
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "app.json"), "{}");
    fs.writeFileSync(path.join(cwd, "webapp", "eas.json"), "{}");

    const suggested = await suggestSkills({
      cwd,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-expo-qr-cache-")),
      prompt: "why run can not show QR or something to connect webapp",
      skills: [
        ...Array.from({ length: 301 }, (_, index) => ({
          name: `unrelated-${index}`,
          description: "Use for unrelated maintenance tasks.",
          path: `/skills/unrelated-${index}/SKILL.md`
        })),
        {
          name: "expo-deployment",
          description: "Deploy Expo apps to production with EAS Build, production build settings, app stores, OTA updates, and release channels.",
          path: "/skills/expo-deployment/SKILL.md"
        },
        {
          name: "building-native-ui",
          description: "Complete guide for building beautiful apps with Expo Router. Covers running the app, Expo Go, QR code scanning, styling, components, and navigation.",
          path: "/skills/building-native-ui/SKILL.md"
        },
        {
          name: "expo-tailwind-setup",
          description: "Set up Tailwind CSS v4 in Expo with react-native-css and NativeWind v5 for universal styling.",
          path: "/skills/expo-tailwind-setup/SKILL.md"
        },
        {
          name: "frontend-design",
          description: "You are a frontend designer-engineer, not a layout generator.",
          path: "/skills/frontend-design/SKILL.md"
        },
        {
          name: "react-nextjs-development",
          description: "React and Next.js application development with App Router, Server Components, TypeScript, Tailwind CSS, and modern frontend patterns.",
          path: "/skills/react-nextjs-development/SKILL.md"
        }
      ],
      indexedSearcher: indexedSearcherFor({
        "expo-deployment": 0.94,
        "building-native-ui": 0.9,
        "expo-tailwind-setup": 0.86,
        "frontend-design": 0.3,
        "react-nextjs-development": 0.2
      }),
      limit: 3
    });

    expect(suggested.map((skill) => skill.name)).toEqual([
      "expo-deployment",
      "building-native-ui",
      "expo-tailwind-setup"
    ]);
  });

  it("suggests commerce and app integration skills for purchase flows without generic domain bleed", async () => {
    const skills = [
      ...Array.from({ length: 301 }, (_, index) => ({
        name: `unrelated-${index}`,
        description: "Use for unrelated maintenance tasks.",
        path: `/skills/unrelated-${index}/SKILL.md`
      })),
      {
        name: "mcp-management",
        description: "Manage MCP servers and tool access for agent workflows.",
        path: "/skills/mcp-management/SKILL.md"
      },
      {
        name: "metasploit-framework",
        description: "Use for penetration testing, exploitation, and security assessment workflows.",
        path: "/skills/metasploit-framework/SKILL.md"
      },
      {
        name: "better-auth",
        description: "Implement authentication and authorization with a TypeScript auth framework.",
        path: "/skills/better-auth/SKILL.md"
      },
      {
        name: "payment-integration",
        description: "Use when creating payment checkout sessions, wallet flows, billing webhooks, and invoices.",
        path: "/skills/payment-integration/SKILL.md"
      },
      {
        name: "billing-automation",
        description: "Master automated billing systems including invoice generation, balance checks, and payment retries.",
        path: "/skills/billing-automation/SKILL.md"
      },
      {
        name: "frontend-api-integration-patterns",
        description: "Production-ready patterns for integrating frontend applications with backend APIs, including modals and checkout state.",
        path: "/skills/frontend-api-integration-patterns/SKILL.md"
      },
      {
        name: "api-endpoint-builder",
        description: "Build production-ready REST API endpoints with validation, authentication, and service integration.",
        path: "/skills/api-endpoint-builder/SKILL.md"
      },
      {
        name: "wordpress-woocommerce-development",
        description: "Build WooCommerce stores with WordPress payment checkout, order processing, and ecommerce APIs.",
        path: "/skills/wordpress-woocommerce-development/SKILL.md"
      }
    ];

    const suggested = await suggestSkills({
      prompt: [
        "Implement the purchase flow for resources, tutorials, resource collections, and tutorial collections.",
        "Before purchase, check whether the user's wallet balance is sufficient.",
        "If the balance is insufficient, display a modal prompting the user to top up their wallet before proceeding to checkout.",
        "Upon successful payment, grant access permissions through the content-access-service.",
        "The purchased content must automatically appear in the user's /library.",
        "Send notifications to both the buyer and the seller after a successful purchase."
      ].join(" "),
      skills,
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-purchase-data-")),
      indexedSearcher: indexedSearcherFor({
        "payment-integration": 0.94,
        "billing-automation": 0.9,
        "frontend-api-integration-patterns": 0.82,
        "api-endpoint-builder": 0.79,
        "better-auth": 0.46,
        "mcp-management": 0.1,
        "metasploit-framework": 0.1,
        "wordpress-woocommerce-development": 0.1
      }),
      limit: 5
    });

    const names = suggested.map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining([
      "payment-integration",
      "billing-automation",
      "frontend-api-integration-patterns",
      "api-endpoint-builder"
    ]));
    expect(names).not.toContain("mcp-management");
    expect(names).not.toContain("metasploit-framework");
    expect(names).not.toContain("wordpress-woocommerce-development");
  });

  it("uses semantic search results for server stacktraces instead of frontend UI skills", async () => {
    const skills = [
      ...Array.from({ length: 301 }, (_, index) => ({
        name: `unrelated-${index}`,
        description: "Use for unrelated maintenance tasks.",
        path: `/skills/unrelated-${index}/SKILL.md`
      })),
      {
        name: "web-frameworks",
        description: "Debug and implement Node.js web frameworks including NestJS, Fastify, Express, HTTP servers, parser middleware, and backend bootstrap errors.",
        path: "/skills/web-frameworks/SKILL.md"
      },
      {
        name: "backend-development",
        description: "Build and debug backend services, server startup, API runtime errors, database connections, queues, and production service failures.",
        path: "/skills/backend-development/SKILL.md"
      },
      {
        name: "api-endpoint-builder",
        description: "Build and repair REST API endpoints, backend validation, controller routing, and service integration.",
        path: "/skills/api-endpoint-builder/SKILL.md"
      },
      {
        name: "debugging",
        description: "Root cause analysis for runtime errors, stack traces, crashes, failed startups, and production incidents.",
        path: "/skills/debugging/SKILL.md"
      },
      {
        name: "frontend-api-integration-patterns",
        description: "Production-ready patterns for integrating frontend applications with backend APIs, forms, UI modals, and checkout state.",
        path: "/skills/frontend-api-integration-patterns/SKILL.md"
      },
      {
        name: "angular-ui-patterns",
        description: "Build Angular UI components, frontend layouts, design systems, and component interaction patterns.",
        path: "/skills/angular-ui-patterns/SKILL.md"
      }
    ];

    for (const prompt of [
      [
        "Fatal bootstrap error: FastifyError: Content type parser 'application/x-www-form-urlencoded' already present.",
        "at Object.addContentTypeParser (/app/node_modules/fastify/lib/content-type-parser.js:360:30)",
        "at FastifyAdapter.registerParserMiddleware (/app/node_modules/@nestjs/platform-fastify/adapters/fastify-adapter.js:345:14)",
        "at NestApplication.listen (/app/node_modules/@nestjs/core/nest-application.js:175:13)"
      ].join(" "),
      [
        "Production startup failed with Express server Prisma connection error.",
        "Unhandled exception in src/main.ts while listen starts the backend API.",
        "Need debug middleware/bootstrap path, not frontend UI."
      ].join(" ")
    ]) {
      const suggested = await suggestSkills({
        prompt,
        skills,
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-backend-runtime-data-")),
        indexedSearcher: indexedSearcherFor({
          "web-frameworks": 0.95,
          "backend-development": 0.91,
          "api-endpoint-builder": 0.85,
          "debugging": 0.8,
          "frontend-api-integration-patterns": 0.2,
          "angular-ui-patterns": 0.2
        }),
        limit: 4
      });
      const names = suggested.map((skill) => skill.name);

      expect(names).toEqual(expect.arrayContaining([
        "web-frameworks",
        "backend-development",
        "api-endpoint-builder",
        "debugging"
      ]));
      expect(names).not.toContain("frontend-api-integration-patterns");
      expect(names).not.toContain("angular-ui-patterns");
    }
  });

  it("uses MCP project metadata for context retrieval debugging prompts", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-mcp-project-"));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      keywords: ["context", "hooks", "mcp", "semantic-search"],
      dependencies: {
        "@modelcontextprotocol/sdk": "^1.29.0"
      }
    }));

    const suggested = await suggestSkills({
      cwd,
      prompt: "can not see suggested skills / files, suggested skills not match prompt",
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-mcp-project-data-")),
      skills: [
        ...Array.from({ length: 301 }, (_, index) => ({
          name: `unrelated-${index}`,
          description: "Use for unrelated maintenance tasks.",
          path: `/skills/unrelated-${index}/SKILL.md`
        })),
        {
          name: "mcp-builder",
          description: "Create MCP Model Context Protocol servers that enable LLMs to interact with external services through tools.",
          path: "/skills/mcp-builder/SKILL.md"
        },
        {
          name: "mcp-management",
          description: "Manage Model Context Protocol MCP servers, tools, prompts, resources, and MCP client integrations.",
          path: "/skills/mcp-management/SKILL.md"
        },
        {
          name: "mcp-tool-developer",
          description: "Build Model Context Protocol MCP servers and tools from scratch.",
          path: "/skills/mcp-tool-developer/SKILL.md"
        },
        {
          name: "agent-memory-mcp",
          description: "A hybrid memory system for AI agents that runs as an MCP server.",
          path: "/skills/agent-memory-mcp/SKILL.md"
        }
      ],
      indexedSearcher: indexedSearcherFor({
        "mcp-builder": 0.96,
        "mcp-management": 0.93,
        "mcp-tool-developer": 0.9,
        "agent-memory-mcp": 0.88
      }),
      limit: 7
    });

    expect(projectSkillHints({ cwd })).toEqual(expect.arrayContaining(["mcp", "modelcontextprotocol"]));
    expect(suggested.map((skill) => skill.name)).toEqual([
      "mcp-builder",
      "mcp-management",
      "mcp-tool-developer",
      "agent-memory-mcp"
    ]);
  });

  it("suggests document authoring skills without document-processing or workspace-automation bleed", async () => {
    const suggested = await suggestSkills({
      prompt: "edit the project document and create workspace documentation",
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-doc-data-")),
      skills: [
        ...Array.from({ length: 301 }, (_, index) => ({
          name: `unrelated-${index}`,
          description: "Use for unrelated maintenance tasks.",
          path: `/skills/unrelated-${index}/SKILL.md`
        })),
        {
          name: "doc-coauthoring",
          description: "Structured workflow for guiding users through collaborative document creation and editing.",
          path: "/skills/doc-coauthoring/SKILL.md"
        },
        {
          name: "documentation",
          description: "Documentation generation workflow covering API docs, architecture docs, README files, code comments, and technical writing.",
          path: "/skills/documentation/SKILL.md"
        },
        {
          name: "docs-architect",
          description: "Creates comprehensive technical documentation from existing codebases and implementation patterns.",
          path: "/skills/docs-architect/SKILL.md"
        },
        {
          name: "wiki-page-writer",
          description: "Generates comprehensive technical documentation pages with evidence-based depth.",
          path: "/skills/wiki-page-writer/SKILL.md"
        },
        {
          name: "writer",
          description: "Document creation, format conversion, and automation with LibreOffice Writer.",
          path: "/skills/writer/SKILL.md"
        },
        {
          name: "azure-ai-document-intelligence-ts",
          description: "Extract text, tables, and structured data from documents using Azure prebuilt and custom models.",
          path: "/skills/azure-ai-document-intelligence-ts/SKILL.md"
        },
        {
          name: "docusign-automation",
          description: "Automate DocuSign templates, envelopes, signatures, and document management.",
          path: "/skills/docusign-automation/SKILL.md"
        },
        {
          name: "asana-automation",
          description: "Automate Asana tasks, projects, sections, teams, and workspaces.",
          path: "/skills/asana-automation/SKILL.md"
        }
      ],
      indexedSearcher: indexedSearcherFor({
        "doc-coauthoring": 0.95,
        "documentation": 0.9,
        "docs-architect": 0.87,
        "wiki-page-writer": 0.84,
        "writer": 0.8,
        "azure-ai-document-intelligence-ts": 0.2,
        "docusign-automation": 0.2,
        "asana-automation": 0.2
      }),
      limit: 5
    });

    const names = suggested.map((skill) => skill.name);
    expect(names).toEqual([
      "doc-coauthoring",
      "documentation",
      "docs-architect",
      "wiki-page-writer",
      "writer"
    ]);
    expect(names).not.toContain("azure-ai-document-intelligence-ts");
    expect(names).not.toContain("docusign-automation");
    expect(names).not.toContain("asana-automation");
  });

  it("suggests global skills with lightweight scoring when embeddings are disabled", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-lightweight-next-"));
    fs.mkdirSync(path.join(cwd, "webapp"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: ["webapp"]
    }));
    fs.writeFileSync(path.join(cwd, "webapp", "package.json"), JSON.stringify({
      dependencies: {
        next: "^15.0.0",
        react: "^19.0.0",
        "socket.io-client": "^4.0.0"
      }
    }));

    const suggested = await suggestSkills({
      cwd,
      prompt: "create forum page, where to show new topic, trending, and chatting everyone",
      embeddingsEnabled: false,
      limit: 5,
      skills: [
        {
          name: "nextjs-app-router-patterns",
          description: "Build Next.js App Router pages, layouts, route groups, server components, and frontend UI flows.",
          path: "/home/user/.codex/skills/nextjs-app-router-patterns/SKILL.md"
        },
        {
          name: "realtime-chat",
          description: "Implement chat, messaging, realtime topics, websocket interactions, and conversation UI.",
          path: "/home/user/.codex/skills/realtime-chat/SKILL.md"
        },
        {
          name: "metasploit-framework",
          description: "Security exploitation workflows for penetration testing.",
          path: "/home/user/.codex/skills/metasploit-framework/SKILL.md"
        }
      ]
    });

    const names = suggested.map((skill) => skill.name);
    expect(names).toEqual(expect.arrayContaining([
      "nextjs-app-router-patterns",
      "realtime-chat"
    ]));
    expect(names).not.toContain("metasploit-framework");
    expect(suggested.every((skill) => skill.reasons.some((reason) => reason.startsWith("lightweight:")))).toBe(true);
  });

  it("reads package metadata across monorepo workspace globs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-skill-monorepo-hints-"));
    fs.mkdirSync(path.join(cwd, "apps", "mobile"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "libs", "shared"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
      workspaces: {
        packages: ["apps/*", "libs/*"]
      },
      scripts: {
        "mobile:start": "npm run start -w apps/mobile"
      }
    }));
    fs.writeFileSync(path.join(cwd, "apps", "mobile", "package.json"), JSON.stringify({
      scripts: {
        start: "expo start",
        web: "expo start --web"
      },
      dependencies: {
        expo: "^56.0.0",
        "expo-router": "^6.0.0",
        nativewind: "^5.0.0",
        "react-native": "^0.85.0"
      },
      devDependencies: {
        tailwindcss: "^4.0.0"
      }
    }));
    fs.writeFileSync(path.join(cwd, "libs", "shared", "package.json"), JSON.stringify({
      dependencies: {
        zod: "^4.0.0"
      }
    }));
    fs.writeFileSync(path.join(cwd, "apps", "mobile", "app.config.js"), "export default {};\n");

    expect(projectSkillHints({ cwd })).toEqual(expect.arrayContaining([
      "expo",
      "start",
      "nativewind",
      "react",
      "native",
      "tailwindcss",
      "zod",
      "app",
      "config"
    ]));
  });
});

function writeSkill(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: Use for ${name} tasks.`,
    "---"
  ].join("\n"));
}

function writeSkillWithMetadata(directory, name, metadata) {
  writeSkill(directory, name);
  fs.writeFileSync(path.join(directory, "skill.yaml"), `${metadata}\n`);
}

function indexedSearcherFor(scoresBySkillName, onTask) {
  return async ({ task }) => {
    onTask?.(task);
    return {
      status: "enabled",
      items: Object.entries(scoresBySkillName).map(([name, embeddingScore]) => ({
        id: normalizeSkillId(name),
        text: name,
        embeddingScore
      }))
    };
  };
}

function normalizeSkillId(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
