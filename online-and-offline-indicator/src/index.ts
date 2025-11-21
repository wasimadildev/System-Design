import express from "express";
import mongoose from "mongoose";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI || "");
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
}

const userSchema = new mongoose.Schema({
  username: String,
  email: String,
  lastLogin: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);

app.post("/register", async (req, res) => {
  try {
    const { username, email } = req.body;
    
    // Check if user already exists
    let user = await User.findOne({ email });
    
    if (user) {
      // Update lastLogin if user exists
      user.lastLogin = new Date();
      await user.save();
      res.status(200).json({ message: "User logged in successfully", User: user });
    } else {
      // Create new user
      const newUser = new User({ username, email, lastLogin: new Date() });
      user = await newUser.save();
      res.status(201).json({ message: "User registered successfully", User: user });
    }
  } catch (error) {
    res.status(500).json({ message: "Server error", error });
  }
});

export interface ExtWebSocket extends WebSocket {
  userId?: string;
  isAlive?: boolean;
}


const userSocket: ExtWebSocket[] = [];

const wss = new WebSocketServer({ port: 8082 });
wss.on("connection", (ws: ExtWebSocket, req) => {
  const userId = req.url?.split("?userId=")[1];
  if (!userId) return;

  ws.userId = userId;
  ws.isAlive = true;
  
  // Check for duplicate connections and remove old one
  const existingIndex = userSocket.findIndex((u) => u.userId === userId);
  if (existingIndex !== -1) {
    console.log(`Removing duplicate connection for user ${userId}`);
    const existingSocket = userSocket[existingIndex];
    if (existingSocket) {
      existingSocket.terminate();
    }
    userSocket.splice(existingIndex, 1);
  }
  
  userSocket.push(ws);

  console.log(`User ${userId} connected`);
  

  updateUserLastLogin(userId);
  broadcastUserStatus();

  ws.on("close", () => {
    const index = userSocket.findIndex((u) => u.userId === userId);
    if (index !== -1) {
      userSocket.splice(index, 1);
      console.log(`User ${userId} disconnected`);
      broadcastUserStatus();
    }
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });
});


async function updateUserLastLogin(userId: string) {
  try {
    await User.findByIdAndUpdate(userId, { lastLogin: new Date() });
  } catch (error) {
    console.error("Error updating last login:", error);
  }
}


async function broadcastUserStatus() {
  try {

    const onlineUserIds = userSocket.map((ws) => ws.userId).filter(Boolean) as string[];

   
    const users = await User.find({}, "_id username email");


    const usersWithStatus = users.map((user) => ({
      _id: user._id,
      username: user.username,
      email: user.email,
      online: onlineUserIds.includes(user._id.toString()),
    }));


    for (const ws of userSocket) {
      ws.send(
        JSON.stringify({
          type: "user-status",
          users: usersWithStatus,
        })
      );
    }
  } catch (error) {
    console.error("Error broadcasting user status:", error);
  }
}

async function deleteInactiveUsers() {
  try {
    const tenMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    
    const inactiveUsers = await User.find({
      lastLogin: { $lt: tenMinutesAgo }
    });

    if (inactiveUsers.length > 0) {
      const result = await User.deleteMany({
        lastLogin: { $lt: tenMinutesAgo }
      });
      
      console.log(`Deleted ${result.deletedCount} inactive users`);
      
      broadcastUserStatus();
    }
  } catch (error) {
    console.error("Error deleting inactive users:", error);
  }
}

setInterval(() => {
  userSocket.forEach((ws) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    if (!ws.isAlive) {
      console.log(`Terminating dead connection for user ${ws.userId}`);
      ws.terminate();
      const index = userSocket.findIndex((u) => u.userId === ws.userId);
      if (index !== -1) {
        userSocket.splice(index, 1);
        broadcastUserStatus();
      }
    } else {
      ws.isAlive = false;
      ws.ping();
    }
  });
}, 30000); 


setInterval(() => {
  deleteInactiveUsers();
}, 2 * 60 * 1000);



setInterval(() => {
  const initialCount = userSocket.length;
  
  
  for (let i = userSocket.length - 1; i >= 0; i--) {
    const ws = userSocket[i];
    if (!ws) {
      console.log(`Removing undefined/stale connection at index ${i}`);
      userSocket.splice(i, 1);
      continue;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`Removing stale connection for user ${ws.userId}`);
      userSocket.splice(i, 1);
    }
  }
  
  const removedCount = initialCount - userSocket.length;
  if (removedCount > 0) {
    console.log(`Cleaned up ${removedCount} stale connections from pool`);
    broadcastUserStatus();
  }
}, 60000);


connectDB()
  .then(() => {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => console.error("Failed to start server:", err));