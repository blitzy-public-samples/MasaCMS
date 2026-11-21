<!--- Tag-syntax component sample --->
<cfcomponent extends="mura.cfobject" output="false">

<cfproperty name="label" type="string" default="">

<cffunction name="getLabel" access="public" output="false" returntype="string">
	<cfreturn variables.label>
</cffunction>

<cffunction name="setLabel" access="public" output="false">
	<cfargument name="label" type="string" required="true">
	<cfset variables.label = arguments.label>
	<cfreturn this>
</cffunction>

</cfcomponent>
