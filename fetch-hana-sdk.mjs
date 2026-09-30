/**
 * 把本机 HanaAgent 随包提供的 SDK 取到 `sdk/`，让 `npm install` 能解析这两个 `file:` 依赖。
 *
 * 为什么要这一步：`@hana/app-sdk` 与 `@hana/plugin-sdk` **不在 npm 上**（`npm view` 是 404），
 * 它们由 HanaAgent 发行版以 `.tgz` 的形式放在
 * `<HANA_HOME>/skills/hana-app-creator/assets/sdk/`。而 `package.json` 里的依赖路径
 * 必须与机器无关——写绝对路径会把作者的用户名写进公开仓库，写 `./sdk/…` 又要求那个目录
 * 已经存在。两条都只对一半人成立。
 *
 * 所以分工在这里：二进制不入库（`.gitignore` 排掉 `sdk/`），由每个用户从**自己装好的
 * HanaAgent** 里取——用这个插件的人本来就有 HanaAgent。`preinstall` 会在装依赖之前跑，
 * 失败时给出可照做的提示，而不是一个 `ENOENT: .../sdk/hana-app-sdk.tgz`。
 *
 * 用法：
 *   npm install          # 自动：preinstall 会先跑这个脚本
 *   node fetch-hana-sdk.mjs   # 手动：只补 sdk/，不装任何东西
 *   HANA_HOME=/custom/.hanako npm install   # 指定 HanaAgent 根目录
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根 = 本文件所在目录（package.json 也在这里）。 */
const ROOT = dirname(fileURLToPath(import.meta.url));
/** 依赖声明里写的就是这个目录。 */
const DEST = join(ROOT, "sdk");

/** 两个必需文件，与 `package.json` 的 `file:` 依赖一一对应。 */
const FILES = ["hana-app-sdk.tgz", "hana-plugin-sdk-0.0.0.tgz"];

/**
 * 本机 HanaAgent 根目录。
 *
 * `HANA_HOME` 优先，其次是默认的 `~/.hanako`。不猜别的位置：猜错的表现是"装不上"，
 * 而那句报错会指向一个用户根本没听过的路径。
 */
function hanaHome() {
  const fromEnv = (process.env.HANA_HOME || "").trim();
  return fromEnv || join(homedir(), ".hanako");
}

/** 发行版放置 SDK tgz 的目录（由 hana-app-creator 这个内置 skill 携带）。 */
function sdkSource(home) {
  return join(home, "skills", "hana-app-creator", "assets", "sdk");
}

function main() {
  const home = hanaHome();
  const source = sdkSource(home);

  // 已经齐了就什么都不做——重装依赖时不该覆盖一份人工替换过的 sdk/。
  const present = FILES.filter((name) => existsSync(join(DEST, name)));
  if (present.length === FILES.length) {
    console.log(`[fetch-hana-sdk] sdk/ 里已齐（${present.length}/${FILES.length}），跳过。`);
    return 0;
  }

  const missing = FILES.filter((name) => !existsSync(join(DEST, name)));
  if (!existsSync(source)) {
    console.error(
      `[fetch-hana-sdk] 找不到 SDK 目录：${source}\n` +
        "  没有装 HanaAgent，或它装在别处。可用 HANA_HOME 指向它，例如：\n" +
        "    HANA_HOME=/path/to/.hanako npm install\n" +
        "  也可以手动把这两个文件拷进去（版本必须与你的 HanaAgent 对应）：\n" +
        FILES.map((n) => `    ${n}`).join("\n") +
        "\n  然后重新运行 npm install。",
    );
    return 1;
  }

  const absentUpstream = missing.filter((name) => !existsSync(join(source, name)));
  if (absentUpstream.length) {
    console.error(
      `[fetch-hana-sdk] ${source} 里缺少：${absentUpstream.join("、")}\n` +
        "  这个目录由内置 skill hana-app-creator 携带，版本可能比你的 HanaAgent 旧；" +
        "更新 HanaAgent 后重试。",
    );
    return 1;
  }

  mkdirSync(DEST, { recursive: true });
  for (const name of missing) {
    const to = join(DEST, name);
    copyFileSync(join(source, name), to);
    console.log(
      `[fetch-hana-sdk] ${name} ← ${join(source, name)}（${(
        statSync(to).size /
        1024
      ).toFixed(1)} KB）`,
    );
  }
  console.log(`[fetch-hana-sdk] 取自 ${home}；这两个文件不进版本库（见 .gitignore）。`);
  return 0;
}

process.exitCode = main();

// 让 `node fetch-hana-sdk.mjs` 单独可执行时也拿到非零退出码。
if (process.exitCode !== 0) process.exit(process.exitCode);
