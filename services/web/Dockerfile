FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# nginx serves the built files and forwards /api to the api service, so the
# browser talks to one origin: no CORS, and the API port need not be exposed.
# Pinned by digest, like the other third-party images in docker-compose.yml,
# so the offline stand runs the exact bytes this was built and tested against.
FROM nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
