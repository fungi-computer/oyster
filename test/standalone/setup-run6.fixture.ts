/** Minimized from run 6 developer calls 4, 5, 16 and 17. No credentials or user files. */
const patch = [
  "*** Begin Patch",
  "*** Add File: notes-app/app.ts",
  "+function render(){return `${n.title}`;}",
  "*** End Patch",
].join("\n");

export const run6Developer = {
  listing: {
    path: ".",
    results: [{ path: "/workspace/g1b.txt", type: "file" }],
    truncated: null,
  },
  patch,
  brokenExecute:
    "const r=await G1b_workshop.files.patch({patch:`" + patch + "`});return r;",
} as const;
