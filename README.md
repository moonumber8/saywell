# Saywell speaking practice

English speaking exercises with Thai meanings, example audio, and word highlighting.

## Run locally

Requires Node.js 20.19+ or 22.13+.

```powershell
npm install
npm run db:up
npm run dev:all
```

Open the Vite URL, normally http://localhost:5173. A fresh clone starts with an empty catalog; upload your own source from course management. The local `data/` directory and downloaded models are intentionally excluded from Git. Allow microphone access, choose a topic, and speak the displayed English word or phrase. Recognized matching words turn green. At least 85% of the words must agree with the target to unlock the next exercise. Case and punctuation are ignored. Retry incorrect attempts as often as needed.

Run `npm test` for tests that work from a clean clone. `npm run test:corpus` checks the optional locally prepared VOA corpus and needs the corresponding files in `data/`.

The curriculum builder uses the Node backend and the configured AI provider: local Ollama needs no API key; Alibaba Cloud uses a server-only key. Speech recognition uses Qwen cloud transcription when configured, with browser SpeechRecognition as a selectable alternative. Use Chrome or Safari on localhost or HTTPS. Recognition checks the words heard, not pronunciation quality.

Example audio uses local **Kokoro-82M v1.0** (Apache-2.0), running on the server CPU through `kokoro-onnx`. English words, sentences, listening checkpoints and coaching practice use the same American English voice (`af_heart`). Normal speed is 1.0 and slow practice is synthesized at 0.75; both have separate persistent caches in `data/tts-audio/`. No cloud TTS key or quota is needed. Audio is generated on demand without adding work to PDF import. `POST /api/speaking/audio` accepts `{text, speed: "normal" | "slow"}` (up to 600 English characters) and returns PCM16 WAV at 24 kHz. One private Python worker keeps the model in memory, limits CPU inference to four threads, serializes requests, and terminates canceled inference. The client unlocks AudioContext inside the user click before fetching, stops playback when recording starts or the page is hidden, and unlocks listening answers only when playback finishes. Service failures remain visible. Qwen speech recognition, coaching and course planning retain their existing providers.

On Windows, run `npm run audio:setup` once before starting the API. This creates a private Python 3.12 runtime and virtual environment under `.runtime/`, installs pinned voice dependencies, and downloads approximately 354 MB of model/voice files to `models/kokoro/` with SHA256 verification. It does not change global Python or Windows PATH. Internet is needed for setup; synthesis works offline afterward. Optional server settings: `KOKORO_VOICE`, `KOKORO_PYTHON`, `KOKORO_MODEL_PATH`, `KOKORO_VOICES_PATH`. The private runtime and weights are excluded from git and Vite watches. For other operating systems, create `.runtime/kokoro` with Python 3.12, install `kokoro-requirements.txt`, then run `node setup-kokoro.mjs`.

## RAG curriculum

The app opens with a curriculum builder. Start Ollama with `qwen3-embedding:4b` for embeddings and configure the text AI provider below. Local text generation also needs `qwen3.5:9b`. Run `npm run dev:all` (the curriculum screen requires the backend).

Choose a CEFR level, a source course or all courses at that level, and the topic you want to practice. The server embeds curriculum chunks with `qwen3-embedding:4b`, stores them in Qdrant, retrieves up to four matching chunks using Qdrant cosine vector search with level and course filters, and asks Qwen to arrange 3–6 speaking exercises. The server validates English phrases and citations against retrieved source text. Bilingual sources keep their original paired translations. Raw book sources receive AI-generated Thai translations, clearly labelled in the app. Rewritten English phrases are discarded. Speaking answers still use deterministic word matching.

Use **เพิ่มเนื้อหาหลักสูตรของพี่** to paste your own material, optionally including a goal and `English phrase | คำแปลไทย` pairs. One submission accepts 30–30,000 characters. Choose its level before saving. Saving starts the same background analysis and course-preparation job as uploading a file. Original documents persist in `data/curriculum.json`; prepared AI plans persist separately in `data/course-plans/`.

Vectors and curriculum chunk payloads are stored in Qdrant, in Docker volume `saywell_qdrant_data`. Original curriculum documents remain in `data/curriculum.json`. Collections use the `saywell_curriculum_` prefix followed by a content/model fingerprint. A new content or model revision creates a new collection; old collections are retained, and retrieval uses only the current revision. Vector dimensions are detected from embeddings. This also allows changing embedding models without mixing incompatible vectors.

The old `data/embedding-index.json` file is read only for one-time migration when its fingerprint matches the current curriculum. Search does not use the file, and new vectors are not written to it. If Qdrant is unavailable, the app reports an error instead of switching to file search.

Docker Desktop must be running. `npm run db:up` starts Qdrant, `npm run db:stop` stops it while preserving data, and `npm run rag:index` imports or indexes the current curriculum. The first lesson also indexes automatically. Do not run `docker compose down -v` unless you intend to delete the stored vectors. The original curriculum can be re-indexed, but the database volume itself is not a backup.

Open the Qdrant dashboard at http://localhost:6333/dashboard. Its port is bound to localhost. Set `QDRANT_URL`, `QDRANT_COLLECTION`, and optionally `QDRANT_API_KEY` in `.env` for another Qdrant server. The Compose image is pinned by digest for reproducible setup. See the [official Qdrant local setup guide](https://qdrant.tech/documentation/quickstart/).

The first lesson can take longer while models load. Set `OLLAMA_EMBEDDING_MODEL` in `.env` to override the default. API keys are not needed for the local configuration. Curriculum writes are intended for a local app; do not expose this backend publicly without access controls.

Endpoints: `GET /api/curriculum`, `POST /api/curriculum` (`title`, `level`, `content`), and `POST /api/curriculum/lesson` (`query`, `level`, optional `documentId`).

## Upload curriculum files

Use **อัปโหลดไฟล์หลักสูตร** on the main screen. Select a CEFR level, choose a `.txt`, `.md`, `.pdf`, or `.docx` file, and press **นำเข้าทั้งเล่ม**. To review short files manually, uncheck the whole-book option and press **อ่านไฟล์และแสดงตัวอย่าง**. Files are limited to 50 MB. Whole-book imports accept up to 2 million extracted characters; the manual preview accepts up to 30,000 characters. Text files must use UTF-8; PDFs must contain selectable text (scanned PDFs need OCR first).

Whole-book upload now reads and stores the original text, analyzes every text slice with AI, prepares reusable teaching units, and then indexes the source for supplementary search. Short-file preview returns the original extracted text for editing without saving; **บันทึกหลักสูตร** then starts background course preparation. The original upload stays in `data/imports/` until the job completes, allowing interrupted or failed work to resume.

If analysis or indexing fails, the source remains saved and **ลองนำเข้าต่อ** resumes the job. Completed AI slices are reused, including after a backend restart; do not re-upload a duplicate document. Learning navigation remains available during background preparation, and the catalog refreshes to show chapters that become ready.

`POST /api/curriculum/upload` accepts multipart fields `file` and `level` and returns an original-text preview without saving. `POST /api/curriculum` accepts title, level and content and now returns HTTP 202 plus an import job. `POST /api/curriculum/documents/:id/prepare` starts a preparation job for an existing source without duplicating it. `POST /api/curriculum/index` remains available for indexing saved content.

## AI course preparation at upload

For new curriculum formats, `course-planner.mjs` analyzes consecutive slices of up to 4,500 characters rather than a four-chunk retrieval window. Each AI request receives the chapter title, chosen CEFR level, current source slice and the previous two summaries. AI proposes ordered vocabulary, grammar, conversation, pronunciation, strategy, activity, writing, listening or review units, with Thai teaching explanations, objectives, exact source evidence, copied English examples, Thai meanings and a concrete practice task. Non-teaching material such as copyright and resources is summarized and retained as reference material. The existing reviewed VOA chapter plans are reused when their goals/source structure still validate.

AI selects objective evidence and English examples by IDs from a list extracted directly from the current slice. The constrained schema limits those IDs to the actual candidates; the application copies the source text itself, preserves supplied bilingual meanings, and removes repeated selections. It checks resolved evidence and examples against that exact slice, requires Thai explanations/translations, and attempts one correction if a request fails. Each request has a 120-second deadline. Partial analyses are saved atomically and progress identifies the chapter, slice and retry. Ready badges appear only after every slice has been analyzed and validated. Large books take time proportional to their content and model response time; the job continues when the page closes.

Prepared units use the existing teach, practice, check and review player. Cloze and listening checkpoints are built from the copied examples, so answers come from source words; writing/activity units require a saved draft. The player uses prepared content without another AI call, grades checkpoints on the server, and preserves browser progress. The evidence validates source provenance, not the semantic accuracy of every Thai explanation or translation: AI plans should be reviewed. The checks do not establish mastery of every curriculum skill.

Source fingerprints invalidate old plans when title, level or content changes. Stored plans include the analyzed slices, objective evidence and model identity. Back up `data/course-plans/` with `data/curriculum.json`. The owner can choose an existing unprepared or failed course and use **ให้ AI เตรียมแบบเรียนจากต้นฉบับบทนี้**. Preparation endpoints remain blocked through the public Cloudflare learner gateway.

Coverage distinguishes all analyzed characters, source mapped to teaching units and reference-only material. Original text remains inspectable. This does not reconstruct unavailable video/images or OCR scanned PDFs; adapted exercises are not every original quiz question. AI-generated tasks are labelled separately from verbatim original activities.

## AI provider and chat endpoint

Interactive text generation and speaking advice use Alibaba Cloud `qwen3.8-flash` by default. Set the following server-only values in `.env`:

```dotenv
AI_PROVIDER=qwen-chat
QWEN_MODEL=qwen3.8-flash
QWEN_REGION=ap-southeast-1
QWEN_WORKSPACE_ID=your-workspace-id
QWEN_API_KEY=your-private-key
```

The text adapter uses the workspace HTTPS Chat Completions endpoint. Singapore uses `ap-southeast-1`; Beijing uses `cn-beijing`. It authenticates from Node, supplies result schemas and source candidates, and enforces timeouts and cancellation. Topic suggestions, live supplementary exercises, transcript coaching and the existing chat endpoint use this interactive provider. Structured study and grading use saved, source-validated plans. `QWEN_REALTIME_URL` is used by the separate speech recognizer.

Upload-time course planning has a separate provider. The default cost-conscious configuration uses **Qwen3.8-Flash** to analyze PDF/text/DOCX content, select source examples, prepare teaching units and Thai meanings, and prepare missing VOA glossary/dialogue translations:

```dotenv
COURSE_AI_PROVIDER=qwen-chat
COURSE_AI_MODEL=qwen3.8-flash
COURSE_AI_STRUCTURED_MODE=json_object
```

The course provider inherits `QWEN_API_KEY`, workspace and region. It uses the workspace HTTPS endpoint `/compatible-mode/v1/chat/completions`; `COURSE_AI_BASE_URL` and `COURSE_AI_KEY` optionally override its endpoint/key. `json_object` sends the schema in the prompt and retains all application checks of fields, Thai text, source IDs, evidence and examples. The complex course schema exceeded the 120-second deadline in strict API schema mode during the POC check; JSON object mode generated a validated full plan in about 24 seconds in that check. `COURSE_AI_STRUCTURED_MODE=json_schema` optionally enables native strict schema enforcement. Both modes require complete responses, retain deadlines/cancellation and never switch to a different model after an error. Existing validated plans and reviewed VOA chapters are reused; changing the creation model does not regenerate completed courses or reset learner progress. Leave `COURSE_AI_PROVIDER` empty to inherit the interactive provider. Set `COURSE_AI_MODEL=qwen3.8-max` only for an import that needs the strongest analysis quality. Model reference: [Qwen3.8-Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max).

Keep credentials in the ignored `.env` file; never add `VITE_` credentials or send the provider key to the browser. API errors redact the key. Malformed structured JSON receives one automatic correction attempt before an error is shown; source validation remains mandatory. The public gateway blocks environment files. `AI_PROVIDER=ollama` restores local text generation.

Embeddings still use local `OLLAMA_EMBEDDING_MODEL` and Qdrant. Keep Ollama and Qdrant running for indexing and supplementary semantic search. Microphone coaching still compares recognized text; this provider change does not add audio pronunciation assessment or replace browser example voices.

Learner recordings use the dedicated `qwen3-asr-flash-realtime` recognizer by default, configured with `QWEN_ASR_MODEL`. It is separate from `AI_PROVIDER` and `QWEN_MODEL`, so switching speech recognition does not change course planning or text feedback.

The existing POST /api/ollama/chat endpoint remains available separately; curriculum generation uses its own endpoint. Configure OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_EMBEDDING_MODEL, and optionally PORT in .env using .env.example. `npm run server` starts the backend alone. `npm run dev:all` starts both the backend and the web app.

## Teaching and practice formats

Select a specific course first. The app automatically asks AI for up to four Thai topic suggestions from that course, each supported by three distinct English examples verified against its text. Click a suggestion to fill the practice request, or enter your own topic. Changing the course or language level clears the previous request and suggestions and cancels an unfinished recommendation. Topic requests have a 90-second deadline and successful results are cached by course content and model. `POST /api/curriculum/topics` requires `documentId` and `level`; it reads that course directly without rebuilding the vector index.

Lesson generation checks each AI exercise independently, removes invalid or duplicate entries, and corrects source citations only when the phrase and translation validate against a retrieved source. If fewer than three valid exercises remain, it requests one automatic correction within the existing three-minute deadline. Unsupported English phrases and mismatched bilingual translations remain rejected.

Lesson generation shows live indexing, retrieval, AI generation and validation stages with elapsed seconds. Cancel stops that lesson's upstream requests; shared book indexing continues. Each lesson has a three-minute server deadline so a stalled model releases the screen for retry. `POST /api/curriculum/lesson` returns newline-delimited progress and result events when requested with `Accept: application/x-ndjson`; other clients continue to receive a JSON lesson.

Choose **อยากเรียนแบบไหน?** before or after generating a lesson. The default **หลายรูปแบบ** covers five button activities: choose the Thai meaning, listen and choose, arrange English word tiles, select a missing word, and match English phrases to Thai meanings. Each lesson begins with teaching cards containing the sourced English phrases, Thai meanings, and example audio. The dedicated **ฝึกพูด** mode continues to use the microphone.

Button answers are checked locally against the validated AI lesson. Choices and distractors use that same lesson's phrases, translations, and words; duplicate meanings are removed to avoid ambiguous options. Word ordering uses separate token IDs so repeated words remain usable. Wrong answers can be retried without advancing, and the next step unlocks after a correct answer. The end screen reports completed activities and incorrect attempts. Changing formats restarts practice using the same generated lesson, without another AI request.

Listening uses browser speech synthesis; audio must finish before answer choices unlock. Mixed button practice does not require microphone access. These activities adapt the source phrases and do not recreate every activity in the original teacher's guide.

## Structured curriculum

All **52 imported VOA Let’s Learn English chapters** now have their own structured course. The Introduction is a separate guide with its complete text available in the preview. Choose a chapter, then start its structured course. Chapter cards show natural lesson order, unit counts and browser-saved progress; completing a chapter offers the next chapter.

The builder reads each entire stored chapter rather than the four-chunk RAG search window. It maps every Goals entry to study units, teaches every Key Words entry and every conversation turn, and keeps lossless source sections attached to the relevant units. Course details expose the mapping and character totals. The authored Thai grammar and pronunciation notes vary by chapter. Alphabet/numbers, ordinal cards, month/season vocabulary and time/change activities are also included where specified. Corrupt or mismatched chapter structures are rejected instead of showing a misleading ready badge. `data/course-goals.json` records the goals/strategy used when authoring the plans; changed goals require reviewing the corresponding plan instead of silently retaining an outdated mapping.

Each unit follows teaching, guided practice, a knowledge check, and review. Correct guided practice unlocks the check; a server-calculated score of at least 80% unlocks the next unit. Vocabulary checks reverse the translation direction, grammar checks use another application question, and conversation checks require listening to source sentences. Failed checks provide explanations. Progress and independent-work drafts persist in this browser's localStorage; source or plan revision changes invalidate old progress. This is a local POC record, not an authenticated certificate.

Source English and definitions remain visible beside prepared AI Thai translations. `data/course-glossary.json` keys each vocabulary sense by its word and source definition. `data/course-dialogue-translations.json` keys conversation translations by exact source text. Run `npm run course:prepare` with the configured AI provider available to fill missing entries; interrupted runs resume from cached results. Restart the backend after preparing translations. Normal structured learning does not require a live AI generation or Qdrant lookup. New text without a cached translation falls back visibly to original English rather than inventing a meaning.

Writing and activity units require a saved practice note or draft, but only their knowledge checks are scored. Recorded audio, free writing quality and classroom performance are not assessed. Audio uses browser speech synthesis; optional microphone practice retains AI transcript coaching. Adapted listening checks are scored in the app. Complete original quiz text remains available, including questions that require original video/images; those media-dependent original questions are not graded here. The extracted text does not preserve embedded image/video assets.

`GET /api/curriculum/structured/:id` returns the plan, goal mapping, source sections and coverage counts. `POST /api/curriculum/structured/:id/check` accepts `revision`, `unitId`, `answers` keyed by assessment ID, and `reflection` when required. The server rebuilds the source-validated plan, rejects stale revisions and missing practice notes, and calculates scores from its assessment bank.

## Publish the POC with Cloudflare Tunnel

On Windows, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Start-Publish.ps1
```

The script builds the production app, downloads the official Windows x64 `cloudflared` release if needed and verifies its SHA-256 digest. It starts the API if it is not already running, starts a learner gateway on loopback port 4173, and opens a Quick Tunnel. The HTTPS URL and owned process IDs are saved in `tmp/publish/state.json`; logs are in the same folder. Use `-SkipBuild` only when `dist` already contains the current build. `-ApiPort` and `-PublicPort` override the default 3001/4173 ports. Ollama and Qdrant still need to be running for live AI features.

Anyone with the URL can use the learning features. The public catalog disables course management, and the gateway rejects upload, import, indexing, curriculum writes and the general Ollama chat endpoint. Learning APIs, checkpoint grading, speaking advice and live lesson progress are proxied through the same HTTPS origin. Original source previews remain available to learners. This is a shared POC, without learner accounts; progress remains in each browser.

Keep this computer awake and the services running. A Quick Tunnel URL lasts only for its running session and changes when restarted. To end sharing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Stop-Publish.ps1
```

The stop script checks process start times and stops only services started by the publish script; it keeps a pre-existing local API running. For a permanent domain, configure an account-backed named Cloudflare Tunnel instead of a Quick Tunnel. `npm run publish:serve` runs just the production learner gateway without creating a tunnel.

## Checks

The learner flow has three stages: choose a course card, choose a topic and practice mode, then practice and review. Source badges show the course and PDF page range. Upload and import controls live under the collapsed course-management section. Completion summaries show passed activities, retry counts and phrases to review; retrying those phrases reuses the lesson without another AI request. Speech summaries count text mismatches, not pronunciation scores.

VOA Lessons 1–3 have prepared AI topics and lessons for instant POC starts. These are labelled as prepared lessons and revalidated against the current curriculum on every read. Changed curriculum or a changed model disables stale prepared entries. Run `npm run demo:prepare` to regenerate `data/demo-lessons.json` using the configured AI provider and local embedding/Qdrant services. Other topics still support live AI generation.

Speaking practice passes when the final transcript has at least 85% word agreement with the target, measured with ordered word edit distance. The displayed percentage measures transcript agreement, not accent or acoustic pronunciation. A lower result asks the selected AI provider for a short Thai coaching tip and a target phrase to practice with slow example audio. The learner can retry the microphone immediately; doing so cancels unfinished advice. Advice has a 60-second server deadline and never changes the word-agreement result. Only target, translation and transcript text go to `/api/speaking/advice`; this coaching endpoint does not assess pronunciation or accent.

With the dedicated Qwen ASR model configured, speaking practice defaults to **อัดเสียงแล้วตรวจด้วย AI**, including on iPhone Chrome. It captures microphone audio through Web Audio, shows a live level meter, and starts the 30-second limit only after audio samples arrive. Tap **หยุดและตรวจ** to stop the microphone and submit mono PCM16 at 16 kHz to `/api/speaking/transcribe`. The server uses `qwen3-asr-flash-realtime` with an English language hint and a 60-second deadline. The expected answer is never sent to ASR, and assistant-generated text is never used as the learner's transcript. Recordings stay in memory and the app does not save audio files; submitted audio is processed by Alibaba Cloud. Qwen credentials stay on the server. Word agreement is not a phoneme assessment.

If Qwen reports that its free ASR quota is exhausted, the API returns `ASR_QUOTA_EXHAUSTED` instead of a generic connection error. The learner switches to browser speech recognition for the next recording when the browser supports it. The app does not enable paid billing or submit the recording to another cloud provider automatically.

The learner can also choose browser speech recognition, when supported. Opening, listening and processing have separate states; permission dialogs do not consume the recording allowance. Browser interim text is a preview and only final transcription is graded once. Canceling, leaving the page or hiding it releases recording resources and ignores late results. Microphone access requires HTTPS (or local development on localhost) and browser/device permission. Mobile viewport checks and automated capture tests do not replace a physical iPhone microphone test.

```powershell
npm run build
npm run lint
npm test
```

## Whole-book imports

Use **พรีวิวเนื้อหาที่นำเข้า** to browse the full stored text of each source section, its original filename, and PDF page range without generating an AI lesson. Page numbers refer to the file's page order, not printed page labels. This is a text preview: embedded images, diagram layouts, and linked audio/video are not stored in the vector index. AI practice requests retrieve at most four chunks and return 3–6 exercises; this is a selection of the preserved source, not a full rendering of every exercise in the book. `GET /api/curriculum/documents/:id` returns the stored source section.

The default upload mode saves the entire extracted curriculum automatically. PDFs with Lesson numbers in page headers are grouped by Lesson; table-of-contents entries do not create lessons. Other PDFs are grouped into bounded parts; text documents can split on Lesson, Unit or Chapter headings. Oversized chapters are split further, preserving all source text. Each source section includes its page range when available. One import supports up to 1,000 sections, and the curriculum catalog supports up to 2,000 documents.

The app prepares source-backed course plans before importing raw source text into Qdrant in batches of eight chunks. Up to four chapters are planned concurrently; slices inside each chapter remain sequential to preserve their context. The importer serializes its status writes, continues other chapters when one fails, and reuses completed analyses when retrying. The VOA teacher guide is identified from its actual page headers even when the upload filename is random. Headings such as Writing inside that guide can remain reference material; ordinary learner lessons still cannot skip teaching headings.

Analysis and indexing are separate progress stages. The owner page reconnects to the current import after refresh, shows stage elapsed time and chapter counts, and lets learners open completed chapters while the rest of the book is being prepared. The public catalog hides owner import-job metadata. Ordinary structured learning uses the stored plans immediately; supplementary learner-selected topics can generate live AI exercises after indexing. Qwen3.8 chat requests explicitly use `reasoning_effort=none` alongside disabled thinking; the course model remains Qwen3.8-Max. The selected CEFR level applies to imported sections and is not an automated certification of the book's level.

Import jobs and failed-job input files persist under data/imports. Closing the page does not stop the backend job, and restarting the backend resumes queued or unfinished jobs. Failed jobs have a retry button. Retries reuse completed Qdrant batches and stable source document IDs; importing the identical file at the same level does not duplicate documents. Completed jobs remove the temporary binary upload and retain a status record. The browser remembers the current import ID to reconnect after refresh.

POST /api/curriculum/import accepts multipart file and level and returns 202 plus a job ID. GET /api/curriculum/import/:id returns progress. POST /api/curriculum/import/:id/retry resumes a failed job. Only three jobs may queue at once, and workers process them serially.
