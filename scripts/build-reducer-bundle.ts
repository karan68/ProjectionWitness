import { buildReducerBundle } from "./lib/reducer-bundle.js";

const result = await buildReducerBundle(process.argv[2]);
console.log(JSON.stringify({ event: "reducer.bundle.built", ...result }));
