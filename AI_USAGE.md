# AI usage

We used **Claude (Claude Code)** to help build this project. Every team member
went over the code and can explain every line of the Dockerfiles, the Compose
file and the workflows.

> ✏️ Team: add your own prompts and experiences below. The teacher wants to
> see *your* real process.

## Prompts we used

1. *(Shared the assignment .docx)* "what i need to do ?"
   → The AI summarized the requirements and the two tracks.
2. "not the 1 the second"
   → We chose Track 2. The AI generated the first version of the project:
   the API, dashboard, Compose file, Dockerfiles and workflows.
3. _…add more prompts here (e.g. asking to explain AOF vs RDB, changing the theme, fixing bugs)…_

## Where the AI got it wrong and how we fixed it

### Example 1: unhandled errors in async Express routes

**What happened:** The first version of `api/server.js` used `async` route
handlers directly, for example `app.get("/api/cars", async (req, res) => {...})`.
In **Express 4**, if an `async` handler throws (for example because Redis is
down), Express does **not** catch the error. The request just hangs with no
response, and Node prints an "unhandled promise rejection" warning.

**How we fixed it:** We added a small wrapper that passes errors to Express,
plus an error handler that returns `500`:

```js
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

app.get("/api/cars", wrap(async (req, res) => { ... }));

app.use((err, _req, res, _next) => {
  res.status(500).json({ error: "Internal server error" });
});
```

**Lesson:** AI code can look right and still miss framework-specific details.
(Express 5 handles this automatically; Express 4 does not.)

### Example 2

_…add another real mistake you found while working (wrong command, wrong config, outdated syntax…) and how you fixed it…_
