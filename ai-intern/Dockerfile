# JIRA-AI-Intern — queue worker + tiny HTTP API.
# Talks to Ollama (compose service or host) or a cloud chat API. Writes reports
# and briefs onto the shared jira-intern volume for the board to render.
FROM python:3.14-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    INTERN_DIR=/app/jira-intern \
    PORT=4322
COPY worker.py brief.py cursor_prices.py cloud_config.py models.json cursor-prices.json cloud-models.json /app/
COPY prompts /app/prompts
EXPOSE 4322
# /health answers 503 once a queue worker thread has died, so `docker ps` shows it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python3 -c "import os,sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '4322') + '/health', timeout=4).status == 200 else 1)"
CMD ["python3", "-u", "/app/worker.py"]
