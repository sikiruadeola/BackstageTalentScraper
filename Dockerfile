FROM apify/actor-node-playwright-chrome:22 AS builder
USER root
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --include=dev --audit=false
COPY . ./
RUN npm run build
RUN npm prune --omit=dev

FROM apify/actor-node-playwright-chrome:22
USER root
WORKDIR /usr/src/app
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/.actor ./.actor
CMD npm run start --silent
