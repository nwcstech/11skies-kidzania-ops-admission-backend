# Use the official Node.js image.
FROM node:14

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Make sure the models directory is copied
RUN ls -la /usr/src/app/models

# Expose the port the app runs on
EXPOSE 4000

# Set environment variable
ENV NODE_ENV=production

# Run the web service on container startup.
CMD [ "npm", "start" ]