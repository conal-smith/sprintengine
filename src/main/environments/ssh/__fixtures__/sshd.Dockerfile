# The SSH machine the phase 8 integration suites connect to (spec 9.3):
# Ubuntu with OpenSSH, a `dev` user whose key is injected at run time, and a
# `.bashrc` that prints a line above its interactive guard, as many do, so
# every exchange has noise before its first marker. python3 serves the dev
# page the pane suites load through the relay.
FROM ubuntu:24.04
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get -o Acquire::Retries=3 install -y --no-install-recommends openssh-server python3 procps \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash dev \
 && echo 'dev:devpass' | chpasswd \
 && mkdir -p /run/sshd /home/dev/.ssh \
 && chown dev:dev /home/dev/.ssh && chmod 700 /home/dev/.ssh \
 && sed -i '1i echo "Welcome to build-box (a line a login profile printed)"' /home/dev/.bashrc
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
