# Stage 1: Build the frontend
FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Stage 2: Final image
FROM python:3.11-slim
WORKDIR /app

# Install backend dependencies
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY backend/ ./

# Copy built frontend assets to a static folder the backend can serve
COPY --from=frontend-builder /app/frontend/dist ./static

# Set environment variables
ENV PORT=8000
EXPOSE 8000

# Start the application
CMD ["python", "main.py"]
