// =====================================================================
// Smart Parking API
// =====================================================================
// This file is the "brain" of the parking lot.
// It is a small web server. Other programs send it requests, and it
// answers them. It is the ONLY part of the system that talks to the
// database (Redis), so all the parking rules live here.
//
// The requests it understands:
//   POST   /api/cars          <- the camera says "a car with this plate came in"
//   GET    /api/cars          <- the guard's screen asks "who is parked right now?"
//   DELETE /api/cars/:plate   <- the "release car" button: the car leaves and pays
//   GET    /api/health        <- Docker asks "are you alive?"
// =====================================================================


// ---------------------------------------------------------------------
// 1. Load the tools we need
// ---------------------------------------------------------------------

// Express = a library that makes it easy to build a web server.
const express = require("express");

// The official library for talking to a Redis database.
// We only need one thing from it: "createClient", which makes a connection.
const { createClient } = require("redis");


// ---------------------------------------------------------------------
// 2. Settings
// ---------------------------------------------------------------------
// "process.env" holds settings passed in from outside (in our case from
// docker-compose.yml). If a setting is missing, we use the value after "||".
// Number(...) turns text like "10" into the number 10.

// The "door" number the server listens on for requests.
const PORT = Number(process.env.PORT || 3000);

// Where the database is. Inside Docker this is "redis://redis:6379"
// ("redis" is the name of the database container).
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

// How many parking spots the lot has.
const CAPACITY = Number(process.env.CAPACITY || 10);

// How many shekels each started hour costs.
const PRICE_PER_HOUR = Number(process.env.PRICE_PER_HOUR || 12);


// ---------------------------------------------------------------------
// 3. Names of the things we save in the database
// ---------------------------------------------------------------------
// Redis saves data under names ("keys"), a bit like file names.
// We keep the names in constants so we don't misspell them later.

// The cars that are inside right now.
// For each car we save its plate and the time it entered.
// It's a "sorted set", so the cars stay sorted by entry time.
const PARKED = "parked";

// The cars that already left (plate, times, price), newest first.
const HISTORY = "history";

// A counter: how many cars ever entered the lot.
const TOTAL_ENTRIES = "stats:totalEntries";

// A counter: how much money the lot has made in total.
const REVENUE = "stats:revenue";


// ---------------------------------------------------------------------
// 4. Prepare the database connection and the server
// ---------------------------------------------------------------------

// Create the connection to Redis (it actually connects later, in start()).
const redis = createClient({ url: REDIS_URL });

// If something goes wrong with the database, print the problem to the log
// instead of crashing the whole server.
redis.on("error", (err) => console.error("Redis error:", err.message));

// Create the web server itself.
const app = express();

// Tell the server: when a request has JSON in it (like {"plate":"12-345-67"}),
// read it and put it in req.body so we can use it.
app.use(express.json());

// A small helper. Our request handlers are "async" (they wait for the
// database). If one of them fails, Express (version 4) wouldn't notice
// the error by itself. "wrap" catches the error and passes it to the
// error handler at the bottom of the file (section 7).
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);


// ---------------------------------------------------------------------
// 5. Helper functions
// ---------------------------------------------------------------------

// Works out how much a car needs to pay.
// Rule: every hour that started costs a full hour, and you always pay
// for at least one hour.
// Example: parked 1 hour and 5 minutes -> 2 hours -> 2 x 12 = 24 shekels.
//   enteredAt = when the car came in (in milliseconds)
//   now       = the time to calculate up to (by default: right now)
function calcPrice(enteredAt, now = Date.now()) {
  // 3_600_000 milliseconds = 1 hour.
  // Math.ceil rounds UP (1.1 hours -> 2). Math.max makes sure it's at least 1.
  const hours = Math.max(1, Math.ceil((now - enteredAt) / 3_600_000));
  return hours * PRICE_PER_HOUR;
}

// Cleans up a license plate and checks that it looks valid.
// Returns the clean plate, or null if it isn't valid.
// Valid examples: 12-345-67, 123-45-678, ABC1234.
function normalizePlate(raw) {
  // If we didn't get text at all, it's not a plate.
  if (typeof raw !== "string") return null;

  // Remove spaces at the start and end, and turn letters to CAPITALS,
  // so "abc1234 " and "ABC1234" count as the same car.
  const plate = raw.trim().toUpperCase();

  // Check the plate: only capital letters, digits and "-",
  // and between 4 and 12 characters long.
  return /^[A-Z0-9-]{4,12}$/.test(plate) ? plate : null;
}


// ---------------------------------------------------------------------
// 6. The requests the server answers
// ---------------------------------------------------------------------
// Each "app.get / app.post / app.delete" says:
// "when a request of THIS type comes to THIS address, run this code".
//   req = the request (what was sent to us)
//   res = the response (what we send back)
// res.status(...) sets the result code. For example:
//   200 = OK, 201 = created, 400 = bad request, 404 = not found,
//   409 = conflict (already exists), 500 = server error, 503 = unavailable.


// --- GET /api/health : "Are you alive?" ------------------------------
// Docker calls this every few seconds to check that the server works.
app.get("/api/health", wrap(async (_req, res) => {
  try {
    // Send a "ping" to the database. If it answers, everything is fine.
    await redis.ping();
    res.json({ ok: true });
  } catch {
    // The database didn't answer, so we say we're not healthy.
    res.status(503).json({ ok: false });
  }
}));


// --- POST /api/cars : "A car came in" --------------------------------
// The camera sends: {"plate": "12-345-67"}
app.post("/api/cars", wrap(async (req, res) => {
  // Take the plate from the request and check it.
  // (The "?." means: if there is no body, don't crash, just give undefined.)
  const plate = normalizePlate(req.body?.plate);

  // Bad or missing plate -> answer "400 Bad request" and stop here.
  if (!plate) return res.status(400).json({ error: "Invalid or missing plate" });

  // Is this car already inside? (zScore gives back its entry time, or null.)
  // If yes -> "409 Conflict", you can't enter twice.
  if ((await redis.zScore(PARKED, plate)) !== null) {
    return res.status(409).json({ error: `${plate} is already parked` });
  }

  // Is the lot full? (zCard = how many cars are in the list.)
  // If yes -> "503", no room.
  if ((await redis.zCard(PARKED)) >= CAPACITY) {
    return res.status(503).json({ error: "Parking lot is full" });
  }

  // Everything is OK, so let the car in.
  // Remember the entry time (in milliseconds since 1970, the usual way
  // computers count time).
  const enteredAt = Date.now();

  // Save two things in the database together, as one action ("multi"),
  // so it never happens that only one of them is saved:
  //   1. add the car to the "parked" list with its entry time
  //   2. add 1 to the "total entries" counter
  await redis.multi().zAdd(PARKED, { score: enteredAt, value: plate }).incr(TOTAL_ENTRIES).exec();

  // Write a line to the log so we can see what happened.
  console.log(`IN  ${plate}`);

  // Answer "201 Created" with the plate and entry time.
  res.status(201).json({ plate, enteredAt });
}));


// --- GET /api/cars : "Show me everything" ----------------------------
// The guard's screen calls this all the time to stay up to date.
app.get("/api/cars", wrap(async (_req, res) => {
  // Take the time once, so all prices are calculated for the same moment.
  const now = Date.now();

  // Ask the database for 4 things AT THE SAME TIME (faster than one by one):
  //   parked       = all cars inside, with their entry times
  //   totalEntries = how many cars ever entered
  //   revenue      = how much money was made
  //   history      = the last 10 cars that left (positions 0 to 9)
  const [parked, totalEntries, revenue, history] = await Promise.all([
    redis.zRangeWithScores(PARKED, 0, -1), // 0 to -1 = from the first to the last
    redis.get(TOTAL_ENTRIES),
    redis.get(REVENUE),
    redis.lRange(HISTORY, 0, 9),
  ]);

  // Build the answer and send it back as JSON.
  res.json({
    capacity: CAPACITY,          // how many spots in total
    count: parked.length,        // how many cars are inside now
    pricePerHour: PRICE_PER_HOUR,
    // The counters come back as text (or nothing if they don't exist yet),
    // so we turn them into numbers, and use 0 if they're empty.
    totalEntries: Number(totalEntries || 0),
    revenue: Number(revenue || 0),
    // For every car inside: its plate, when it came in,
    // and how much it would pay if it left right now.
    cars: parked.map(({ value, score }) => ({
      plate: value,
      enteredAt: score,
      currentPrice: calcPrice(score, now),
    })),
    // The history is saved as text, so we turn each item back into an object.
    history: history.map((h) => JSON.parse(h)),
  });
}));


// --- DELETE /api/cars/:plate : "This car is leaving" -----------------
// Example: DELETE /api/cars/12-345-67
// ":plate" means that part of the address is the plate number.
app.delete("/api/cars/:plate", wrap(async (req, res) => {
  // Take the plate from the address and check it.
  const plate = normalizePlate(req.params.plate);

  // If the plate is valid, find out when that car entered.
  // If the plate is bad, or the car isn't inside, we get nothing back.
  const enteredAt = plate && (await redis.zScore(PARKED, plate));

  // No entry time -> the car isn't here -> "404 Not found".
  if (enteredAt == null) return res.status(404).json({ error: "Car not found" });

  // The car is leaving now. Work out how much it pays.
  const leftAt = Date.now();
  const price = calcPrice(enteredAt, leftAt);

  // A short summary of this parking visit.
  const record = { plate, enteredAt, leftAt, price };

  // Update the database, all together as one action:
  await redis
    .multi()
    .zRem(PARKED, plate)                         // 1. remove the car from "parked"
    .incrBy(REVENUE, price)                      // 2. add the price to the total money
    .lPush(HISTORY, JSON.stringify(record))      // 3. put the summary at the top of the history
    .lTrim(HISTORY, 0, 49)                       // 4. keep only the newest 50 in the history
    .exec();

  // Write to the log and send the summary back to the screen.
  console.log(`OUT ${plate} paid ${price}`);
  res.json(record);
}));


// ---------------------------------------------------------------------
// 7. Error handler (the safety net)
// ---------------------------------------------------------------------
// If anything above fails unexpectedly, we end up here.
// We print the full error to the log (for us), and send the user a
// simple "500 Internal server error" without the technical details.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});


// ---------------------------------------------------------------------
// 8. Start everything
// ---------------------------------------------------------------------

// First connect to the database, and only then start taking requests.
// (No point answering requests if we can't save anything.)
async function start() {
  await redis.connect();
  app.listen(PORT, () => console.log(`API listening on :${PORT} (capacity ${CAPACITY})`));
}

// Run start(). If it fails (for example, the database can't be reached),
// print why and close the program with an error code (1).
// Docker will see that and restart the container.
start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
