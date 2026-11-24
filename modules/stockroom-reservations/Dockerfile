FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home stockroom && mkdir data && chown stockroom data
COPY stockroom ./stockroom
USER stockroom
EXPOSE 8000
CMD ["uvicorn", "stockroom.api:app", "--host", "0.0.0.0", "--port", "8000"]
