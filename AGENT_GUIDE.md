# Research with Webweave Nook

Nook runs at `http://127.0.0.1:4177`. Keep the app open while working. Its Research tab can copy instructions, export a packet, import a response, and review pending suggestions.

## Read context

`GET /api/agent/context` returns saved collection metadata, exact quote text, OCR text, tags, missing fields, and draft themes and arrangements. Image pieces have an `imageUrl` pointing to a local image endpoint. Private notes are excluded. `GET /api/agent/schema` returns the supported proposal format and a complete example.

The supplied CLI uses only Node.js:

```text
node nook-agent.js context
node nook-agent.js schema
node nook-agent.js submit proposal.json
node nook-agent.js inbox
```

Set `NOOK_URL` only if Nook uses another local port. An exported research packet can also be used without the API. Return a JSON proposal for the user to import.

## Submit suggestions

Send JSON to `POST /api/agent/proposals` with `Content-Type: application/json`. No browser database access or direct file modification is needed. A successful response contains a proposal ID and `pending` status. Submitting a proposal does not alter any piece.

```json
{
  "format": "nook-research/v1",
  "agent": "Research assistant",
  "summary": "Verified the original publication and suggested a related passage.",
  "updates": [
    {
      "pieceId": "exact-id-from-context",
      "fields": {
        "creator": "Verified creator",
        "workTitle": "Verified work title",
        "url": "https://example.com/original"
      },
      "evidence": [
        {
          "url": "https://example.com/original",
          "note": "Explain exactly which facts this source supports."
        }
      ]
    }
  ],
  "additions": []
}
```

The example URLs and names above are placeholders. Research real sources before submitting a packet.

Allowed update fields: `creator`, `creatorUrl`, `contributors`, `workTitle`, `workType`, `year`, `url`, `annotation`, `tags`, `altText`, and `visualNotes`. Tags are an array of strings. Additional creators use one `Name | https://profile-url` per line in `contributors`.

New pieces use `kind: "quote"`, `"image"`, or `"link"`, plus the same credit fields. Quotes require `quote` containing the exact passage. Images require `imageUrl` for the image itself and `url` for its source page. Every new piece requires a source `url`. Every update or addition requires at least one `evidence` entry with a URL and explanation.

The user reviews each suggestion. Applying an update fills empty fields and merges tags; it preserves existing filled fields. New images are fetched only after acceptance. Accepted evidence is attached to the piece, and the app records applied packet IDs to avoid applying the same packet twice.

## Research practice

- Prefer original publications, artist sites, institutional collections, and other direct sources. Distinguish the original work from a repost or quotation site.
- Do not invent words, creators, dates, titles, or links. Leave uncertainty unresolved and explain it in the evidence note or packet summary.
- Preserve quotations exactly, including meaningful line breaks. Label translations, excerpts, and details in `annotation` when supported by the source.
- Suggest additions that connect to the draft's stated theme; explain the connection and the attribution.
- Image links expose local files to the local agent. Do not upload those images to external services without the user's authorization.

Research snapshots and proposal files live in `.nook-agent/` beside the app. They are local and are excluded from source control. They are an agent exchange cache, not the primary library. The library itself lives in browser storage and is portable through **Back up all**.
