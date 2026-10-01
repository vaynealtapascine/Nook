(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NookCapture = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const themes = {
    home: /\b(home|house|room|door|window|kitchen|bedroom|shelter)\b/i,
    longing: /\b(longing|yearn\w*|miss\w*|ache|absence|wish\w*)\b/i,
    love: /\b(love\w*|beloved|lover|kiss\w*|affection|tender\w*)\b/i,
    memory: /\b(memory|memories|remember\w*|forgot\w*|past|nostalgia)\b/i,
    nature: /\b(tree\w*|forest|flower\w*|garden|leaf|leaves|bird\w*|mountain\w*)\b/i,
    water: /\b(water|ocean|sea|river|rain\w*|wave\w*|shore|lake)\b/i,
    light: /\b(light|sun\w*|moon\w*|star\w*|shadow\w*|dawn|dusk)\b/i,
    grief: /\b(grief|mourn\w*|loss|death|died|sorrow|bereave\w*)\b/i,
    time: /\b(time|hour\w*|day\w*|years?|season\w*|etern\w*|moment\w*)\b/i,
    identity: /\b(identity|myself|yourself|ourselves|self|become|belong\w*)\b/i,
    body: /\b(body|bodies|hands?|skin|heart|bones?|breath\w*|eyes?)\b/i,
    dreams: /\b(dream\w*|sleep\w*|nightmare\w*|awake\w*)\b/i,
  };
  function suggestTags(piece) {
    // Words and source text only; never guess a scene or an attribution.
    const text = [piece.quote, piece.ocrText, piece.workTitle, piece.title].filter(Boolean).join(" ");
    const hashtags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu)].map(m => m[1].toLowerCase());
    const found = Object.entries(themes).filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
    return [...new Set([...hashtags, ...found])].slice(0, 6);
  }
  const needsTranscription = piece => piece.kind === "image" && !!piece.imageData && !piece.trashed && !piece.ocrText && piece.transcriptionStatus !== "done";
  const needsTagging = piece => !piece.trashed && !(piece.tags || []).length && piece.taggingStatus !== 'done';
  return { suggestTags, needsTranscription, needsTagging };
});
