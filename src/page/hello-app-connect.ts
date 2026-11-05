import { connectApp } from "@fungi.computer/agar";

// The starter Hello App's page script, bundled into `helloAppScript`. An App
// is open once its page announces itself to the host; a page that never does
// leaves the window on "didn't respond in time" with its content hidden.
await connectApp({ host: "parent" });
