import { saveAccount } from "../../server/accounts";
// Only spawned with the parent fixture's disposable CAPY_DATA_DIR; no network or token request.
saveAccount("youtube", { clientSecret: "replacement-child-fixture" });
