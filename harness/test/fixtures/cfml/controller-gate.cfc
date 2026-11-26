// Admin controller sample with a module gate, an opaque gate and CSRF-checked branches
component extends="controller" output="false" {

	public any function before(rc) {
		arguments.rc.isAdmin = ListFind(arguments.rc.$.currentUser().getMemberships(), 'Admin;#arguments.rc.$.siteConfig('privateUserPoolID')#;0') || ListFind(arguments.rc.$.currentUser().getMemberships(), 'S2');

		if ( ListLast(arguments.rc.muraAction, ':') != 'cFixture.special' ) {
			if ( !arguments.rc.isAdmin && !variables.permUtility.getModulePerm('00000000000000000000000000000000008', arguments.rc.siteid) ) {
				secure(arguments.rc);
			}
		} else if ( !getBean('fixtureGate').allows(arguments.rc) ) {
			secure(arguments.rc);
		}
	}

	public any function update(rc) {
		if ( arguments.rc.$.validateCSRFTokens(context="update") ) {
			switch(arguments.rc.action) {
				case 'Update' :
					arguments.rc.userBean=getUserManager().update(arguments.rc);
					break;
				case 'Delete' :
					getUserManager().delete(arguments.rc.userid,arguments.rc.type,true);
					break;
				case 'Add' :
					arguments.rc.userBean=getUserManager().create(arguments.rc);
					break;
			}
		}
	}

	public any function remove(rc) {
		if ( arguments.rc.$.validateCSRFTokens(context=arguments.rc.userid) ) {
			getUserManager().delete(arguments.rc.userid,arguments.rc.type,true);
		}
	}

	public any function list(rc) {
		arguments.rc.rs = getUserManager().getUserGroups(siteid=arguments.rc.siteid, ispublic=0);
	}

}
