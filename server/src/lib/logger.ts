import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  serializers: {
    error: pino.stdSerializers.err,
  },
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});
