FROM curlimages/curl:8.11.1

# The camera script: sends a random plate to the API every few seconds
COPY --chmod=755 camera.sh /camera.sh

# Settings (can be changed in docker-compose.yml)
ENV API_URL=http://api:3000/api/cars
ENV INTERVAL=10

ENTRYPOINT ["/camera.sh"]
