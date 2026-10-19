FROM python:3.12-alpine
RUN apk add --no-cache rclone rsync openssh-client su-exec tzdata
WORKDIR /app
COPY import.py entrypoint.sh ./
RUN chmod -R a+rX /app && chmod a+x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python", "-u", "import.py"]
