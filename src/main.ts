import { restoreCache } from "@actions/cache";
import { getInput, saveState, setFailed } from "@actions/core";
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
  name: getInput("name") || "registry",
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
    name: string;
  },
) {
  const users = inputs.users.split(",").filter(Boolean).map(v => ({
    username: v.slice(0, v.indexOf(":")),
    password: v.slice(v.indexOf(":") + 1),
  }));

  if (users.length === 0) {
    users.push({
      username: "registry",
      password: "registry",
    });
  }

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

  run("依存関係をインストール", () => {
    execSync(`sudo apt-get update -y`, { stdio: "inherit" });
    execSync(`sudo apt-get install -y libnss3-tools`, { stdio: "inherit" });
  });

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

    const certFile = JSON.stringify(path.join(certsdir, "domain.crt"));
    const keyFile = JSON.stringify(path.join(certsdir, "domain.key"));
    execSync(
      `${mkcert} -cert-file ${certFile} -key-file ${keyFile} `
        + `localhost ${JSON.stringify(inputs.name)}`,
      {
        stdio: "inherit",
        env: {
          ...process.env,
          CAROOT: carootdir,
        },
      },
    );
    console.log("domain.crt:");
    execSync(`cat ${certFile}`, { stdio: "inherit" });
    console.log();
    console.log("domain.key:");
    execSync(`cat ${keyFile}`, { stdio: "inherit" });
    console.log();
  });

  run("registry を起動", async () => {
    // https://github.com/distribution/distribution/issues/4270
    execSync(
      `docker run \\
      -d \\
      --network bridge \\
      --restart=always \\
      --name ${JSON.stringify(inputs.name)} \\
      -e OTEL_TRACES_EXPORTER=none \\
      -p ${inputs.port}:5000 \\
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
  });

  await setTimeout(1e3);
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
  const bin = "mkcert-v" + version + "-" + os + "-" + arch;
  const key = bin;
  const mkc = path.join(process.cwd(), "mkcert");
  const restored = await restoreCache([mkc], key);

  if (restored) {
    saveState("cache", JSON.stringify({ hit: true, mkc, key }));
    return mkc;
  }

  const url = "https://github.com/FiloSottile/mkcert/releases/download/v"
    + version + "/" + bin;
  execSync("wget -q -O mkcert " + url, { stdio: "inherit" });
  saveState("cache", JSON.stringify({ hit: false, mkc, key }));

  return mkc;
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
