class TreeNode {
	parent?: TreeNode;

	get root() {
		return this.parent ? this.parent.root : this;
	}
}
