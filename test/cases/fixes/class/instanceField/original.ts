class Counter {
	count;

	increment() {
		this.count = (this.count ?? 0) + 1;
	}
}
