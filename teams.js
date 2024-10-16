const express = require("express");
const dotenv = require("dotenv");
const fetch = require("node-fetch");

dotenv.config();

const app = express();
app.use(express.json());

const FLOWISE_API_URL = process.env.FLOWISE_API_URL || ""; // Ensure this is set in your environment variables

// Simple logger function
function logger(...params) {
  console.error("[Teams Integration]", ...params);
}

// Query Flowise API to get responses from chatflow
async function queryFlowise(question, sessionId) {
  const data = {
    question: question,
    overrideConfig: {
      sessionId: sessionId || "default-session",  // Provide a default sessionId if none is given
    },
  };

  try {
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error(`Flowise API returned an error: ${response.statusText}`);
    }

    const result = await response.json();
    if (result && result.text) {
      return result.text;
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error.message);
    throw error;
  }
}

// Handle incoming requests from Microsoft Teams
app.post("/teams-webhook", async (req, res) => {
  const { text, sessionId } = req.body;

  // Validate the input
  if (!text || !sessionId) {
    return res.status(400).json({ error: "Invalid input. 'text' and 'sessionId' are required." });
  }

  try {
    // Query the Flowise API (your chatflow)
    const answer = await queryFlowise(text, sessionId);
    res.json({ message: answer });
  } catch (error) {
    logger("Error handling Teams webhook:", error.message);
    res.status(500).json({ error: "Internal Server Error. Please try again later." });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "UP", message: "Teams webhook is running" });
});

// Catch-all route for undefined routes
app.get("*", (req, res) => {
  res.status(404).json({ error: "Not Found" });
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Teams webhook server running on port ${port}`);
});
