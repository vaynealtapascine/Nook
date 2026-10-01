// Small local interface for research agents. No packages are required.
const fs = require("node:fs/promises");
const { validate } = require("./agent-api");
async function main() {
  const [command, file] = process.argv.slice(2),
    base = process.env.NOOK_URL || "http://127.0.0.1:4177";
  let response;
  if (["context", "schema", "inbox"].includes(command))
    response = await fetch(
      base +
        "/api/agent/" +
        { context: "context", schema: "schema", inbox: "proposals" }[command],
    );
  else if (command === "submit" && file) {
    const packet = validate(JSON.parse(await fs.readFile(file, "utf8")));
    response = await fetch(base + "/api/agent/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(packet),
    });
  } else
    throw new Error(
      "Usage: node nook-agent.js context | schema | inbox | submit proposal.json",
    );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  console.log(JSON.stringify(data, null, 2));
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
