
import "dotenv/config";
import express from "express";
import cors from "cors";
import driveTestRoutes from "./router/drive-test.router.js";

import eventsRoutes from "./router/events.routes.js";
import googleRoutes from "./router/google.router.js";

const app = express();


app.use(
  cors({
    origin: process.env.FRONTEND_URL,
  }),
);

app.use(express.json());

// Rota para testar se o backend está funcionando
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    message: "Backend funcionando!",
  });
});

app.use("/api/events", eventsRoutes);
app.use("/auth", googleRoutes);


app.use("/api/drive-test", driveTestRoutes);



const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
