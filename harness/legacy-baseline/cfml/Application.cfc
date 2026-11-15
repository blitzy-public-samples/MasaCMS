// Diagnostic harness application: runs run.cfm inside Masa's application and blocks app reloads.
component extends="muraWRM.Application" output="false" {

	boolean function onRequestStart(string targetPage) output=false {
		var reloadKey = (structKeyExists(application, "appReloadKey") && len(application.appReloadKey)) ? application.appReloadKey : "appreload";
		// Masa re-decodes url (setEncoding) before its reload check, so deleting the key first cannot stop a reload; its own reload flag does.
		if (structKeyExists(url, reloadKey)) {
			request.muraAppreloaded = true;
		}
		var started = super.onRequestStart();
		structDelete(url, reloadKey);
		return started;
	}

}
