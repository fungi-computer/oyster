import { connectApp } from "@fungi.computer/agar";
import { appBackend } from "@fungi.computer/agar/backend";
import { computerReadFile } from "@fungi.computer/agar/computer";
import * as z from "zod";
import packageMetadata from "../package.json" with { type: "json" };

// The manifest declares the Save command once, for the Release and this UI.
const [saveCommand] = packageMetadata.fungi.app.commands;
if (saveCommand === undefined) throw new Error("Notes declares a Save command");
const note = document.querySelector("#note");
const save = document.querySelector("#save");
const status = document.querySelector("#status");
const readFile = document.querySelector("#read-file");
const file = document.querySelector("#file");
if (
  !(note instanceof HTMLTextAreaElement) ||
  !(save instanceof HTMLButtonElement) ||
  !(status instanceof HTMLOutputElement) ||
  !(readFile instanceof HTMLButtonElement) ||
  !(file instanceof HTMLOutputElement)
)
  throw new Error("Notes markup is missing");

const root = await connectApp({
  host: "parent",
});
const backend = root.capabilities.require(appBackend);
const read = z
  .object({ text: z.string().nullable() })
  .parse(
    await backend.request(JSON.stringify({ method: "readNote", input: {} })),
  );
note.value = read.text ?? "";
const saveNote = async () => {
  await backend.request(
    JSON.stringify({ method: "saveNote", input: { text: note.value } }),
  );
  status.value = "Saved";
};
save.addEventListener("click", () => {
  void saveNote();
});
readFile.addEventListener("click", () => {
  void (async () => {
    const handle = await root.capabilities.require(computerReadFile).open({
      path: "/welcome.txt",
    });
    try {
      file.value = await (await handle.response()).text();
    } finally {
      await handle.close();
    }
  })().catch((error: unknown) => {
    file.value = error instanceof Error ? error.message : "File unavailable";
  });
});
await root.commands.register(saveCommand, async () => {
  await saveNote();
  return undefined;
});
root.ui.onStatusAction(async (action) => {
  if (action.itemId !== "note" || action.optionId !== "save") return false;
  await saveNote();
  return true;
});
await root.ui.reportStatus([
  {
    kind: "menu",
    id: "note",
    text: "Note",
    options: [{ id: "save", text: "Save note" }],
  },
]);
status.value = "Connected";
