type Tickable = {
  tick(time: number): boolean;
};

class SharedScheduler {
  private clients = new Set<Tickable>();
  private frame = 0;

  add(client: Tickable): void {
    this.clients.add(client);
    if (!this.frame) this.frame = requestAnimationFrame(this.loop);
  }

  remove(client: Tickable): void {
    this.clients.delete(client);
    if (!this.clients.size && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  private loop = (time: number): void => {
    this.frame = 0;
    for (const client of this.clients) {
      if (!client.tick(time)) this.clients.delete(client);
    }
    if (this.clients.size) this.frame = requestAnimationFrame(this.loop);
  };
}

export const scheduler = new SharedScheduler();
