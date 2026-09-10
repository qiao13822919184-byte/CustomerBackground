FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY --from=build /app /app
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
VOLUME ["/data"]
CMD ["npm","start"]
