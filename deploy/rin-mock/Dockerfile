# Section 9.6: local stand-in for ИАИС «РиН» on the offline verification
# stand. No dependencies - node:20-slim runs the one file directly.
FROM node:20-slim
WORKDIR /app
COPY server.js ./
ENV PORT=8090
EXPOSE 8090
CMD ["node", "server.js"]
