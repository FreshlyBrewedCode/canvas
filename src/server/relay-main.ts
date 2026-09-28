// The Docker image's entry (`Dockerfile`): `canvas relay` alone, bundled into one file.
import { runRelay } from "./relay-cli";

runRelay(process.argv.slice(2), process.env);
