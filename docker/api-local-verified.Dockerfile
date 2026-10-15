# Local promotion of the compiled, tested API into the existing dependency image.
# No schema synchronization or data migration runs during this promotion.
FROM ai-platform-api
COPY apps/api/dist /app/apps/api/dist
COPY packages/shared/dist /app/packages/shared/dist
WORKDIR /app/apps/api
CMD ["node", "dist/main.js"]
