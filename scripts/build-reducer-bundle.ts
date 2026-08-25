import { buildReducerBundle } from "./lib/reducer-bundle.js";

if (process.argv[2] !== undefined) {
  throw new Error("build:reducer does not accept an output path");
}
const result = await buildReducerBundle();
console.log(JSON.stringify({ event: "reducer.bundle.built", ...result }));
