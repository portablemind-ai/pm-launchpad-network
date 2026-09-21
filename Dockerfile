# Zero-dependency app: Node + source, nothing to install.
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY setup ./setup
ENV PORT=8080 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
USER node
CMD ["node", "server.js"]
