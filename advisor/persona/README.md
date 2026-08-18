# Recording your voice

Two files feed the AI:

**`style-guide.md`** — your judgment. Rewrite it completely in your own words. This is
the single highest-leverage hour you'll spend on this project.

**`qa/*.md`** — your phrasing. Add as many files as you like; every `.md` file in this
folder is loaded. Format:

```
Q: The question, phrased the way a client would actually ask it
A:
Your answer, exactly as you'd say it out loud.

Multiple paragraphs are fine.

Tags: optional, comma separated
---
Q: The next question
A:
...
```

Entries are separated by a line containing only `---`.

## How to build the corpus fast

Talk, don't write. Open a voice memo, have someone ask you the fifty questions you get
most, and answer them the way you would on a call — including the tangents. Transcribe
it (any transcription tool), then paste it in and split it into Q/A blocks. Three hours
of talking gets you further than a week of typing, and it sounds like you because it *is*
you talking.

Prioritize by frequency: the twenty questions you answer every week matter far more than
the exotic ones. And record the ones where you say *no* — refusals are the most
distinctive thing about an advisor's voice, and a generic AI never gets them right.

Files reload automatically when they change on disk. Edit and hit send again — no restart.
