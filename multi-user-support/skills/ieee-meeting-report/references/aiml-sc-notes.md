# IEEE 802.11 meeting document conventions

Quick hints for reading the extracted Markdown. These are conventions, not guarantees — trust the specific document in front of you when it disagrees.

## Document-name decoding (DCN)

Filenames follow `11-YY-NNNN-RR-<tg>-<slug>.<ext>` — for example:

- `11-26-0256-01-aiml-aiml-sc-march-2026-vancouver-agenda.pptx`
  - Year 2026, submission 0256, revision 01
  - Task group: `aiml` (the AI/ML Standing Committee)
  - Role: agenda

The short forms you'll see on slides and in minutes: `11-26/0256r1` ↔ `11-26-0256-01`.

## Typical document roles per session

| Suffix in filename     | Role                   | What to pull from it                                                          |
| ---------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `...-agenda`           | Agenda                 | Agenda items in order, chair/vice-chair/secretary, meeting slot, DCN list.    |
| `...-opening-snapshot` | Opening Snapshot       | Goals for this session, session logistics, teleconference plans.              |
| `...-closing-report`   | Closing Report         | Motion outcomes, session statistics, next-meeting date and topics.            |
| `...-meeting-minutes`  | Minutes                | Full motion text with mover/seconder/result, presentations, Q&A.              |
| (anything else)        | Technical contribution | Individual presentation slides referenced by their DCN in the minutes/agenda. |

## Motion formatting

Motions in the minutes usually appear as:

```
Motion 33: Approve Agenda
Move to approve the agenda for AIML SC as contained in document 11-26/0256r0.
Mover: <name>
Seconded by: <name>
Result: Approved by unanimous consent.
```

- Numbers are sequential across a session, starting at whatever running count the committee uses (not always 1).
- Keep the number, text, mover, seconder, and result verbatim — do not renumber or rephrase.

## Presentation rows

Each technical contribution typically shows up in the minutes with:

- DCN (e.g. `11-26/512r0`)
- Title
- Author / presenter name
- Company affiliation

Slide decks themselves usually carry the same header info on slide 1–2. The extracted Markdown keeps slide boundaries as headings — "Slide 1", "Slide 2", etc. — so you can grep those out fast.

## IEEE policy slides

The minutes and some contributions include the patent / copyright / IPR disclosure slides. **Exclude these** from the report body — they are boilerplate, not session content.

Common headings to skip:

- "Participants have a duty to inform..."
- "Instructions for the WG Chair"
- "Patent Related Links"
- "Call for Essential Patents"

## Teleconference and interim cadence

The closing report or minutes normally list:

- Next meeting date (usually the next WG Plenary / Interim)
- Whether interim teleconferences are planned, and their cadence
- Contribution submission deadline (often "1 week before")
- Expected topics for the next meeting

Pull these into Section 7 of the report verbatim.
