import { saveCache } from "@actions/cache";
import { getState, warning } from "@actions/core";

(async () => {
  const cache = JSON.parse(getState("cache")) as {
    hit: boolean;
    mkc: string;
    key: string;
  };

  if (!cache.hit) {
    try {
      await saveCache([cache.mkc], cache.key);
      process.exit(0);
    } catch (err) {
      warning("mkcert のキャッシュに失敗");
      warning(err instanceof Error ? err : String(err));
    }
  }
})();
