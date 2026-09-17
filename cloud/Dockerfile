FROM node:22-alpine
WORKDIR /app
COPY collector.js server.js ./
USER node
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
