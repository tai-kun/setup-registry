import { getInput, setFailed } from "@actions/core";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout } from "node:timers/promises";
import CONFIG_YML from "./config.yml.js";

main({
  version: getInput("version") || "latest",
  users: getInput("users"),
  port: getInput("port") || "5000",
})
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    setFailed(err);
    process.exit(1);
  });

async function main(
  inputs: {
    version: string;
    users: string;
    port: string;
  },
) {
  const users = inputs.users.split(",").filter(Boolean).map(v => ({
    username: v.slice(0, v.indexOf(":")),
    password: v.slice(v.indexOf(":") + 1),
  }));

  const tmpdir = os.tmpdir();
  const datadir = path.join(tmpdir, "registry", "data");
  const authdir = path.join(tmpdir, "registry", "auth");
  const certsdir = path.join(tmpdir, "registry", "certs");
  const carootdir = path.join(tmpdir, "registry", "caroot");
  const configdir = path.join(tmpdir, "registry", "config");
  fs.mkdirSync(datadir, { recursive: true });
  fs.mkdirSync(authdir, { recursive: true });
  fs.mkdirSync(certsdir, { recursive: true });
  fs.mkdirSync(carootdir, { recursive: true });
  fs.mkdirSync(configdir, { recursive: true });

  run("htpasswd を用意", () => {
    const htpasswd = generateHtpasswdString(users);
    fs.writeFileSync(path.join(authdir, "htpasswd"), htpasswd);
    console.log("htpasswd:");
    console.log(htpasswd);
    console.log();
  });

  run("config.yml を用意", () => {
    const configYml = CONFIG_YML
      .replace(/{{addr}}/g, ":5000")
      .replace(/{{data}}/g, "/var/lib/registry")
      .replace(/{{auth}}/g, "/auth")
      .replace(/{{certs}}/g, "/certs");
    fs.writeFileSync(path.join(configdir, "config.yml"), configYml);
    console.log("config.yml:");
    console.log(configYml);
    console.log();
  });

  await run("証明書を用意", async () => {
    const mkcert = JSON.stringify(
      await downloadMkcert("linux", "amd64", "1.4.4"),
    );
    execSync(`chmod u+x ${mkcert}`, { stdio: "inherit" });
    execSync(`${mkcert} -install`, {
      stdio: "inherit",
      env: {
        ...process.env,
        CAROOT: carootdir,
      },
    });

    const keyFile = JSON.stringify(path.join(certsdir, "domain.key"));
    const certFile = JSON.stringify(path.join(certsdir, "domain.crt"));
    console.log("domain.crt");
    console.log(execSync(`cat ${certFile}`, { stdio: "inherit" }));
    console.log();
    console.log("domain.key");
    console.log(execSync(`cat ${keyFile}`, { stdio: "inherit" }));
    console.log();
    execSync(
      `${mkcert} -cert-file ${certFile} -key-file ${keyFile} localhost`,
      {
        stdio: "inherit",
        env: {
          ...process.env,
          CAROOT: carootdir,
        },
      },
    );
  });

  await run("registry を起動", async () => {
    // https://github.com/distribution/distribution/issues/4270
    execSync(
      `docker run \\
      -d \\
      --restart=always \\
      --name registry \\
      -p ${inputs.port}:5000
      -e OTEL_TRACES_EXPORTER=none \\
      -v ${JSON.stringify(authdir + ":/auth")} \\
      -v ${JSON.stringify(certsdir + ":/certs")} \\
      -v ${JSON.stringify(configdir + ":/config")} \\
      registry:${inputs.version} \\
      /config/config.yml
      `,
      {
        stdio: "inherit",
      },
    );
    await setTimeout(1e3);
  });
}

function run<T>(title: string, cb: () => T): T {
  console.log("::group::" + title);
  let r;

  try {
    r = cb();
  } finally {
    if (!(r instanceof Promise)) {
      console.log("::endgroup::");
    }
  }

  if (r instanceof Promise) {
    r = r.finally(() => {
      console.log("::endgroup::");
    }) as T;
  }

  return r;
}

async function downloadMkcert(
  os: string,
  arch: string,
  version: string,
): Promise<string> {
  const url = "https://github.com/FiloSottile/mkcert/releases/download/v"
    + version + "/mkcert-v" + version + "-" + os + "-" + arch;
  execSync("wget -q -O mkcert " + url, { stdio: "inherit" });

  return path.join(process.cwd(), "mkcert");
}

function generateHtpasswdString(
  users: { username: string; password: string }[],
): string {
  const htpasswdLines = users.map(u => {
    const user = JSON.stringify(u.username);
    const pass = JSON.stringify(u.password);

    return execSync(
      `docker run --rm --entrypoint htpasswd httpd:2 -Bbn ${user} ${pass}`,
      {
        encoding: "utf-8",
        stdio: "pipe",
      },
    ).trim();
  });

  return htpasswdLines.join("\n");
}
