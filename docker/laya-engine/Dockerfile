FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

# CPU-only runtime for the opt-in, single-threaded VPS deployment.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.14.0
RUN pip install --no-cache-dir 'laya[serve]==0.4.23'

EXPOSE 8000
CMD ["laya-serve"]
