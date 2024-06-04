import lark from "@larksuiteoapi/node-sdk";
import dotenv from "dotenv";
import express from "express";
import mongoose from "mongoose";
import fetch from "node-fetch";
import showdown from "showdown";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Database connected successfully"))
  .catch((err) => console.log(err));

const eventSchema = new mongoose.Schema({
  event_id: { type: String, unique: true },
  content: String,
});

const msgSchema = new mongoose.Schema({
  sessionId: String,
  question: String,
  answer: String,
  msgSize: Number,
  createdAt: { type: Date, default: Date.now },
});

const Event = mongoose.model("Event", eventSchema);
const Msg = mongoose.model("Msg", msgSchema);

app.use(express.json());

function logger(param) {
  console.error(`[CF]`, param);
}

async function cmdProcess(cmdParams) {
  switch (cmdParams && cmdParams.action) {
    case "/help":
      await cmdHelp(cmdParams.messageId);
      break;
    case "/clear":
      await cmdClear(cmdParams.sessionId, cmdParams.messageId);
      break;
    default:
      await cmdHelp(cmdParams.messageId);
      break;
  }
  return { code: 0 };
}

async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          text: content,
        }),
        msg_type: "text",
      },
    });
  } catch (e) {
    logger("send message to Lark error", e, messageId, content);
  }
}

async function buildConversation(sessionId, question) {
  const prompt = [];
  const messages = await Msg.find({ sessionId }).sort({ createdAt: 1 });
  messages.forEach((row) => {
    prompt.push({ role: "user", content: row.question });
    prompt.push({ role: "assistant", content: row.answer });
  });
  prompt.push({ role: "user", content: question });
  return prompt;
}

async function saveConversation(sessionId, question, answer) {
  try {
    if (!question || !answer) {
      throw new Error("Question or answer is missing or empty.");
    }
    const msgSize = question.length + answer.length;
    await new Msg({ sessionId, question, answer, msgSize }).save();
    await discardConversation(sessionId);
  } catch (error) {
    logger("Error saving conversation:", error);
    throw error; // Propagate the error further if needed
  }
}

async function discardConversation(sessionId) {
  const messages = await Msg.find({ sessionId }).sort({ createdAt: -1 });
  let totalSize = 0;
  const countList = [];

  messages.forEach((row) => {
    totalSize += row.msgSize;
    countList.push({
      msgId: row._id,
      totalSize,
    });
  });

  for (const c of countList) {
    if (c.totalSize > 1024) {
      await Msg.deleteOne({ _id: c.msgId });
    }
  }
}

async function clearConversation(sessionId) {
  await Msg.deleteMany({ sessionId });
}

async function cmdHelp(messageId) {
  const helpText = `Lark GPT manpages

Usage:
    /clear    remove conversation history for get a new, clean, bot context.
    /help     get more help message
  `;
  await reply(messageId, helpText);
}

async function cmdClear(sessionId, messageId) {
  clearConversation(sessionId);
  await reply(messageId, "✅ All history removed");
}

async function query(data) {
  try {
    const response = await fetch(`${FLOWISE_API_URL}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    const result = await response.json();
    return result;
  } catch (error) {
    console.error("Error querying API:", error);
    throw error;
  }
}

async function doctor() {
  if (LARK_APP_ID === "") {
    return {
      code: 1,
      message: {
        en_US: "Here is no Lark APP id, please check & re-Deploy & call again",
      },
    };
  }
  if (!LARK_APP_ID.startsWith("cli_")) {
    return {
      code: 1,
      message: {
        en_US:
          "Your Lark App ID is Wrong, Please Check and call again. Lark APPID must Start with cli",
      },
    };
  }
  if (LARK_APP_SECRET === "") {
    return {
      code: 1,
      message: {
        en_US:
          "Here is no Lark APP Secret, please check & re-Deploy & call again",
      },
    };
  }
  return {
    code: 0,
    message: {
      zh_CN:
        "✅ 配置成功，接下来你可以在 Lark 应用当中使用机器人来完成你的工作。",
      en_US:
        "✅ Configuration is correct, you can use this bot in your Lark App",
    },
    meta: {
      LARK_APP_ID,
    },
  };
}

async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("question: " + question);
  const action = question.trim();
  if (action.startsWith("/")) {
    return await cmdProcess({ action, sessionId, messageId });
  }
  const prompt = await buildConversation(sessionId, question);
  const openaiResponse = await query({ question: prompt })
    .then((response) => {
      return response.text; // Extract the text field from the response
    })
    .catch((error) => {
      console.error("Error:", error);
    });

  await saveConversation(sessionId, question, openaiResponse);
  await reply(messageId, openaiResponse);

  try {
    await new Event({ event_id: eventId, content: userInput.text }).save();
  } catch (error) {
    if (error.code === 11000) {
      logger("Duplicate event ID:", eventId);
      return { code: 1, message: "Duplicate event ID" };
    } else {
      throw error;
    }
  }
  return { code: 0 };
}

app.post("/webhook", async (req, res) => {
  const params = req.body;
  if (params.encrypt) {
    logger("user enable encrypt key");
    return res.json({
      code: 1,
      message: {
        zh_CN: "你配置了 Encrypt Key，请关闭该功能。",
        en_US: "You have open Encrypt Key Feature, please close it.",
      },
    });
  }
  if (params.type === "url_verification") {
    logger("deal url_verification");
    return res.json({
      challenge: params.challenge,
    });
  }
  if (!params.header || req.query.debug) {
    logger("enter doctor");
    const doc = await doctor();
    return res.json(doc);
  }
  if (params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    const event = await Event.findOne({ event_id: eventId });
    if (event) {
      logger("skip repeat event");
      return res.json({ code: 1 });
    }

    try {
      await new Event({ event_id: eventId }).save();
    } catch (error) {
      if (error.code === 11000) {
        logger("Duplicate event ID:", eventId);
        return res.json({ code: 1, message: "Duplicate event ID" });
      } else {
        throw error;
      }
    }

    if (params.event.message.chat_type === "p2p") {
      if (params.event.message.message_type != "text") {
        await reply(messageId, "Not support other format question, only text.");
        logger("skip and reply not support");
        return res.json({ code: 0 });
      }
      const userInput = JSON.parse(params.event.message.content);
      const result = await handleReply(
        userInput,
        sessionId,
        messageId,
        eventId
      );
      return res.json(result);
    }

    if (params.event.message.chat_type === "group") {
      const userInput = JSON.parse(params.event.message.content);
      const result = await handleReply(
        userInput,
        sessionId,
        messageId,
        eventId
      );
      return res.json(result);
    }
  }

  logger("return without other log");
  return res.json({ code: 2 });
});

app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

// Test
// query({ question: "How can you help me?" })
//   .then((res) =>
//     console.log(
//       res.text
//     )
//   )
//   .catch((e) => console.log(e));
