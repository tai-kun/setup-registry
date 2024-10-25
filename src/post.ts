import { execSync } from "node:child_process";

execSync("docker logs registry", { stdio: "inherit" });
