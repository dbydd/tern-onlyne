import { join } from "node:path";

/** Where the library reads its project configuration; the companion keeps it beside its data. */
export function configPath(dir: string): string {
	return join(dir, ".onlyne", "config.toml");
}
