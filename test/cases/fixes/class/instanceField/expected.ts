class Counter {
	count: number;

	increment() {
		this.count = (this.count ?? 0) + 1;
	}
}
