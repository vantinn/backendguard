import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { JwtAuthGuard } from "../common/jwt-auth.guard";

const UPLOAD_ROOT = "/var/lib/acme/uploads";

@Controller("files")
@UseGuards(JwtAuthGuard)
export class FilesController {
  // Path traversal is prevented by resolving and checking containment.
  @Get(":name")
  async read(@Param("name") name: string) {
    const resolved = path.resolve(UPLOAD_ROOT, path.basename(name));
    const relative = path.relative(UPLOAD_ROOT, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Invalid path");
    }
    return fs.readFile(resolved, "utf8");
  }
}
