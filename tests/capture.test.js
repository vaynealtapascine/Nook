const test = require("node:test");
const assert = require("node:assert/strict");
const { suggestTags } = require("../capture-tools");
const { needsTranscription } = require("../capture-tools");
test("automatic tags use exact hashtags and themes from captured text", () => {
  assert.deepEqual(suggestTags({quote: "I remember the rain outside our home. #fragments"}), ["fragments", "home", "memory", "water"]);
  assert.deepEqual(suggestTags({ocrText: "The forest and the sea"}), ["nature", "water"]);
});
test("automatic tags do not invent scene tags or match word fragments", () => {
  assert.deepEqual(suggestTags({title: "Pasted image", imageData: "data:image/png;base64,abc"}), []);
  assert.deepEqual(suggestTags({quote: "The lighthouse is an apparent statement."}), []);
});
test("interrupted image transcription resumes, while a completed empty reading stays complete", () => {
  const image = {kind:"image", imageData:"data:image/png;base64,abc", ocrText:""};
  assert.equal(needsTranscription({...image, transcriptionStatus:"queued"}), true);
  assert.equal(needsTranscription({...image, transcriptionStatus:"reading"}), true);
  assert.equal(needsTranscription({...image, transcriptionStatus:"done"}), false);
  assert.equal(needsTranscription({...image, ocrText:"Recognized words"}), false);
  assert.equal(needsTranscription({...image, trashed:true}), false);
});
