/**
 * Interactive multi-select prompt using raw stdin.
 *
 * Usage:
 *   const selected = await multiSelect({
 *     message: "Select agents:",
 *     options: [
 *       { label: "Codex",   value: "codex", selected: true },
 *       { label: "Claude",  value: "claude", selected: true },
 *       { label: "Antigravity (agy)", value: "agy", selected: true }
 *     ]
 *   });
 */

const KEYS = {
  UP: ["\x1B[A", "\x1Bk"],       // Arrow Up, Alt+k
  DOWN: ["\x1B[B", "\x1Bj"],     // Arrow Down, Alt+j
  SPACE: [" "],
  ENTER: ["\r", "\n"],
  CTRL_C: ["\x03"],
  // j/k vim-style (single char)
  J: ["j"],
  K: ["k"]
};

const DIM = "\x1B[2m";
const RESET = "\x1B[0m";
const CYAN = "\x1B[36m";
const GREEN = "\x1B[32m";
const BOLD = "\x1B[1m";
const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";

function matchKey(data, keySet) {
  return keySet.some((k) => data === k);
}

/**
 * @param {{ message: string, options: Array<{label: string, value: string, selected?: boolean}> }} config
 * @returns {Promise<string[]>} selected values
 */
export function multiSelect({ message, options }) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: return all pre-selected
      resolve(options.filter((o) => o.selected).map((o) => o.value));
      return;
    }

    let cursor = 0;
    const selections = options.map((o) => o.selected !== false);

    function render() {
      // Move cursor up to overwrite previous render (except first time)
      const lines = [];
      lines.push(`${CYAN}◇${RESET} ${message}`);
      lines.push(`${DIM}  Use ↑/↓ to navigate, Space to toggle, Enter to confirm${RESET}`);
      for (let i = 0; i < options.length; i++) {
        const isCursor = i === cursor;
        const isSelected = selections[i];
        const checkbox = isSelected ? `${GREEN}◉${RESET}` : `${DIM}○${RESET}`;
        const label = isCursor ? `${BOLD}${CYAN}${options[i].label}${RESET}` : options[i].label;
        const pointer = isCursor ? `${CYAN}❯${RESET}` : " ";
        lines.push(`  ${pointer} ${checkbox} ${label}`);
        if (options[i].hint) {
          lines.push(`        ${DIM}${options[i].hint}${RESET}`);
        }
      }
      return lines;
    }

    let prevLineCount = 0;

    function draw() {
      const lines = render();
      // Clear previous output
      if (prevLineCount > 0) {
        process.stdout.write(`\x1B[${prevLineCount}A`); // move up
        for (let i = 0; i < prevLineCount; i++) {
          process.stdout.write("\x1B[2K");  // clear line
          if (i < prevLineCount - 1) process.stdout.write("\x1B[1B"); // move down
        }
        process.stdout.write(`\x1B[${prevLineCount - 1}A`); // back to top
      }
      process.stdout.write(lines.join("\n") + "\n");
      prevLineCount = lines.length;
    }

    process.stdout.write(HIDE_CURSOR);

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function cleanup() {
      process.stdin.setRawMode(wasRaw || false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write(SHOW_CURSOR);
    }

    function onData(data) {
      if (matchKey(data, KEYS.CTRL_C)) {
        cleanup();
        process.exit(0);
      }

      if (matchKey(data, KEYS.UP) || matchKey(data, KEYS.K)) {
        cursor = (cursor - 1 + options.length) % options.length;
        draw();
      } else if (matchKey(data, KEYS.DOWN) || matchKey(data, KEYS.J)) {
        cursor = (cursor + 1) % options.length;
        draw();
      } else if (matchKey(data, KEYS.SPACE)) {
        selections[cursor] = !selections[cursor];
        draw();
      } else if (matchKey(data, KEYS.ENTER)) {
        cleanup();
        const selected = options
          .filter((_, i) => selections[i])
          .map((o) => o.value);
        // Print final summary
        const summary = selected.length > 0
          ? selected.join(", ")
          : "(none)";
        // Overwrite prompt area with final state
        if (prevLineCount > 0) {
          process.stdout.write(`\x1B[${prevLineCount}A`);
          for (let i = 0; i < prevLineCount; i++) {
            process.stdout.write("\x1B[2K");
            if (i < prevLineCount - 1) process.stdout.write("\x1B[1B");
          }
          process.stdout.write(`\x1B[${prevLineCount - 1}A`);
        }
        process.stdout.write(`${CYAN}◇${RESET} ${message}\n`);
        process.stdout.write(`${DIM}│${RESET}  ${GREEN}${summary}${RESET}\n`);
        resolve(selected);
      }
    }

    process.stdin.on("data", onData);
    draw();
  });
}

/**
 * Interactive single-select prompt (radio-button style).
 *
 * @param {{ message: string, options: Array<{label: string, value: string, disabled?: boolean, isHeader?: boolean}> }} config
 * @returns {Promise<string|null>} selected value or null
 */
export function singleSelect({ message, options }) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      // Non-interactive: return first non-disabled
      const first = options.find((o) => !o.disabled);
      resolve(first ? first.value : null);
      return;
    }

    // Filter to only selectable items, but keep the full list for rendering
    const selectableIndices = options
      .map((o, i) => (o.disabled ? -1 : i))
      .filter((i) => i >= 0);
    if (selectableIndices.length === 0) { resolve(null); return; }

    let cursorIdx = 0; // index into selectableIndices
    let cursor = selectableIndices[0]; // actual index in options

    function render() {
      const lines = [];
      lines.push(`${CYAN}◇${RESET} ${message}`);
      lines.push(`${DIM}  Use ↑/↓ to navigate, Enter to select${RESET}`);
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        if (opt.disabled || opt.isHeader) {
          lines.push(`  ${DIM}${opt.label}${RESET}`);
          continue;
        }
        const isCursor = i === cursor;
        const radio = isCursor ? `${GREEN}◉${RESET}` : `${DIM}○${RESET}`;
        const label = isCursor ? `${BOLD}${CYAN}${opt.label}${RESET}` : opt.label;
        const pointer = isCursor ? `${CYAN}❯${RESET}` : " ";
        lines.push(`  ${pointer} ${radio} ${label}`);
      }
      return lines;
    }

    let prevLineCount = 0;

    function draw() {
      const lines = render();
      if (prevLineCount > 0) {
        process.stdout.write(`\x1B[${prevLineCount}A`);
        for (let i = 0; i < prevLineCount; i++) {
          process.stdout.write("\x1B[2K");
          if (i < prevLineCount - 1) process.stdout.write("\x1B[1B");
        }
        process.stdout.write(`\x1B[${prevLineCount - 1}A`);
      }
      process.stdout.write(lines.join("\n") + "\n");
      prevLineCount = lines.length;
    }

    process.stdout.write(HIDE_CURSOR);

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function cleanup() {
      process.stdin.setRawMode(wasRaw || false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stdout.write(SHOW_CURSOR);
    }

    function onData(data) {
      if (matchKey(data, KEYS.CTRL_C)) {
        cleanup();
        process.exit(0);
      }

      if (matchKey(data, KEYS.UP) || matchKey(data, KEYS.K)) {
        cursorIdx = (cursorIdx - 1 + selectableIndices.length) % selectableIndices.length;
        cursor = selectableIndices[cursorIdx];
        draw();
      } else if (matchKey(data, KEYS.DOWN) || matchKey(data, KEYS.J)) {
        cursorIdx = (cursorIdx + 1) % selectableIndices.length;
        cursor = selectableIndices[cursorIdx];
        draw();
      } else if (matchKey(data, KEYS.ENTER)) {
        cleanup();
        const selected = options[cursor];
        // Clear and show result
        if (prevLineCount > 0) {
          process.stdout.write(`\x1B[${prevLineCount}A`);
          for (let i = 0; i < prevLineCount; i++) {
            process.stdout.write("\x1B[2K");
            if (i < prevLineCount - 1) process.stdout.write("\x1B[1B");
          }
          process.stdout.write(`\x1B[${prevLineCount - 1}A`);
        }
        process.stdout.write(`${CYAN}◇${RESET} ${message}\n`);
        process.stdout.write(`${DIM}│${RESET}  ${GREEN}${selected.label}${RESET}\n`);
        resolve(selected.value);
      }
    }

    process.stdin.on("data", onData);
    draw();
  });
}
