<!--- Admin view sample whose CSRF check is short-circuited --->
<cfif true or rc.$.validateCSRFTokens(context="approvalaction")>
	<cfset rc.fixtureResult = "approved">
</cfif>
