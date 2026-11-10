// Blocks HTTP access to harness unit-test fixtures.
component {
	this.name = "opt2-harness-test-fixtures";
	this.sessionManagement = false;

	function onRequestStart(){
		writeOutput('Access Restricted.');
		abort;
	}
}
