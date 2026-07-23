FROM python:3-alpine

WORKDIR /app

COPY read_gpu.py serve.py ./

EXPOSE 9401

CMD ["python3", "serve.py"]
