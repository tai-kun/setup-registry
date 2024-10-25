import { getInput, setFailed, setOutput } from "@actions/core";
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import CONFIG_YML from "./config.yml.js";

main({
  version: getInput("version") || "latest",
  users: getInput("users"),
  addr: getInput("addr") || ":5000",
})
  .then(({ pid }) => {
    setOutput("pid", pid);
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
    addr: string;
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

  // {
  //   execSync(`sudo apt-get update -y`, { stdio: "inherit" });
  //   execSync(`sudo apt-get install -y coreutils`, { stdio: "inherit" });
  //   execSync(`. ~/.bashrc`, { stdio: "inherit" });
  // }
  {
    const htpasswd = generateHtpasswdString(users);
    const configYml = CONFIG_YML
      .replace(/{{addr}}/g, inputs.addr)
      .replace(/{{data}}/g, datadir)
      .replace(/{{auth}}/g, authdir)
      .replace(/{{certs}}/g, certsdir);
    fs.writeFileSync(path.join(authdir, "htpasswd"), htpasswd);
    fs.writeFileSync(path.join(configdir, "config.yml"), configYml);
  }

  const mkcert = JSON.stringify(
    await downloadMkcert("linux", "amd64", "1.4.4"),
  );
  const registry = JSON.stringify(
    await downloadRegistry("linux", "amd64", inputs.version),
  );

  {
    execSync(`chmod u+x ${mkcert}`, { stdio: "inherit" });
    execSync(`chmod u+x ${registry}`, { stdio: "inherit" });
  }
  {
    execSync(`${mkcert} -install`, {
      stdio: "inherit",
      env: {
        ...process.env,
        CAROOT: carootdir,
      },
    });

    const keyFile = JSON.stringify(path.join(certsdir, "domain.key"));
    const certFile = JSON.stringify(path.join(certsdir, "domain.crt"));
    execSync(
      `${mkcert} -cert-file ${keyFile} -key-file ${certFile} localhost`,
      {
        stdio: "inherit",
        env: {
          ...process.env,
          CAROOT: carootdir,
        },
      },
    );
  }
  {
    const out = execSync(
      `${registry} serve "$CONFIG_FILE" &\necho $!`,
      {
        encoding: "utf-8",
        stdio: "pipe",
        env: {
          ...process.env,
          REGISTRY: registry,
          CONFIG_FILE: path.join(configdir, "config.yml"),
          // https://github.com/distribution/distribution/issues/4270
          OTEL_TRACES_EXPORTER: "none",
        },
      },
    );
    const pid = /(\d+)\s*$/.exec(out)![1]!;

    return {
      pid,
    };
  }
}

async function downloadMkcert(
  os: string,
  arch: string,
  version: string,
): Promise<string> {
  const url = "https://github.com/FiloSottile/mkcert/releases/download/v"
    + version + "/mkcert-v" + version + "-" + os + "-" + arch;
  execSync("wget -O mkcert " + url, { stdio: "inherit" });

  return path.join(process.cwd(), "mkcert");
}

async function downloadRegistry(
  os: string,
  arch: string,
  version: string,
): Promise<string> {
  let url = "https://api.github.com/repos/distribution/distribution/releases/";

  if (version === "latest") {
    url += "latest";
  } else {
    if (version[0] === "v") {
      version = version.slice(1);
    }

    url += "tag/" + version;
  }

  const resp = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
    },
  });

  if (!resp.ok) {
    throw new Error(resp.status + " " + resp.statusText);
  }

  const { assets } = await resp.json() as {
    assets: {
      name: string;
      browser_download_url: string;
    }[];
  };

  for (const { name, browser_download_url: url } of assets) {
    if (!name.endsWith("_" + os + "_" + arch + ".tar.gz")) {
      continue;
    }

    execSync("wget -O registry.tar.gz " + url, { stdio: "inherit" });
    execSync("tar -xzvf registry.tar.gz registry", { stdio: "inherit" });
    execSync("rm registry.tar.gz", { stdio: "inherit" });
    break;
  }

  return path.join(process.cwd(), "registry");
}

function generateHtpasswdString(
  users: { username: string; password: string }[],
): string {
  const htpasswdLines = users.map(user => {
    const hashedPassword = generateMD5Hash(user.password);

    return user.username + ":{MD5}" + hashedPassword;
  });

  return htpasswdLines.join("\n");
}

function generateMD5Hash(password: string): string {
  const hash = crypto.createHash("md5");
  hash.update(password);

  return hash.digest("hex");
}
